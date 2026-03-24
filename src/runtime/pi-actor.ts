import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { EpisodeMessage } from "../episode/builder";
import {
	INITIAL_RUN_STATE,
	transitionRunState,
	type ExitedRunState,
	type RunState,
	type RunTerminationReason,
} from "../run/state-machine";
import { terminateProcess } from "./termination";

const THREADS_DIR = ".pi/threads";
const DEFAULT_PI_COMMAND = "pi";
const EXECUTABLE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

type RuntimeMessage = EpisodeMessage & {
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
};

type StreamEvent = {
	type?: string;
	message?: RuntimeMessage;
};

type PromptFile = {
	dir: string;
	filePath: string;
};

type ExitSnapshot = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
};

export interface PiActorUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export const EMPTY_PI_ACTOR_USAGE_STATS: PiActorUsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

export interface PiActorInvocationRequest {
	runId: string;
	thread: string;
	cwd: string;
	action: string;
	model?: string;
	systemPrompt?: string;
	sessionPath?: string;
}

export interface PiActorArgsContext {
	sessionPath: string;
	systemPromptFile?: string;
}

export type PiActorArgsBuilder = (request: PiActorInvocationRequest, context: PiActorArgsContext) => string[];

export interface PiActorRuntimeOptions {
	command?: string;
	buildArgs?: PiActorArgsBuilder;
	defaultSigtermGraceMs?: number;
}

interface PiCommandSpec {
	command: string;
	argsPrefix: string[];
}

export interface PiActorInvokeOptions {
	signal?: AbortSignal;
}

export interface PiActorResult {
	runId: string;
	thread: string;
	finalState: ExitedRunState;
	messages: readonly EpisodeMessage[];
	stderr: string;
	usage: PiActorUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export type PiActorEvent =
	| { type: "state"; state: RunState }
	| { type: "message"; message: EpisodeMessage }
	| { type: "stderr"; chunk: string };

export interface PiActorSnapshot {
	runId: string;
	thread: string;
	pid: number | undefined;
	startedAt: number;
	state: RunState;
}

export interface PiActorHandle {
	readonly runId: string;
	readonly thread: string;
	readonly result: Promise<PiActorResult>;
	cancel(reason?: RunTerminationReason): Promise<void>;
	subscribe(listener: (event: PiActorEvent) => void): () => void;
	getSnapshot(): PiActorSnapshot;
}

interface InvocationOptions {
	request: PiActorInvocationRequest;
	command: string;
	argsBuilder: PiActorArgsBuilder;
	sigtermGraceMs: number;
	waitForTurn: Promise<void>;
	releaseTurn: () => void;
	signal?: AbortSignal;
}

function toNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	return error instanceof Error && /abort/i.test(error.message);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getExitSnapshot(child: ChildProcess): ExitSnapshot | null {
	if (child.exitCode === null && child.signalCode === null) return null;
	return { exitCode: child.exitCode, signal: child.signalCode };
}

function waitForExit(child: ChildProcess): Promise<ExitSnapshot> {
	const exited = getExitSnapshot(child);
	if (exited) return Promise.resolve(exited);

	return new Promise<ExitSnapshot>((resolve, reject) => {
		const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			resolve({ exitCode, signal });
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			child.off("exit", onExit);
			child.off("error", onError);
		};
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function waitForClose(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function makeSessionPath(cwd: string, thread: string): string {
	const safe = thread.replace(/[^\w.-]+/g, "_");
	return path.join(cwd, THREADS_DIR, `${safe}.jsonl`);
}

function ensureSessionDirectory(sessionPath: string): void {
	const dir = path.dirname(sessionPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function resolveSessionPath(
	request: Pick<PiActorInvocationRequest, "cwd" | "thread" | "sessionPath">,
): string {
	return request.sessionPath ?? makeSessionPath(request.cwd, request.thread);
}

function writePromptFile(content: string): PromptFile {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-thread-worker-"));
	const filePath = path.join(dir, "worker.md");
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function cleanupPromptFile(temp: PromptFile | null): void {
	if (!temp) return;
	try {
		fs.unlinkSync(temp.filePath);
	} catch {
		/* ignore */
	}
	try {
		fs.rmdirSync(temp.dir);
	} catch {
		/* ignore */
	}
}

function defaultArgsBuilder(request: PiActorInvocationRequest, context: PiActorArgsContext): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--session",
		context.sessionPath,
	];
	if (request.model) {
		const slashIndex = request.model.indexOf("/");
		if (slashIndex > 0) {
			const provider = request.model.slice(0, slashIndex).trim();
			const modelId = request.model.slice(slashIndex + 1).trim();
			if (provider && modelId) {
				args.push("--provider", provider, "--model", modelId);
			} else {
				args.push("--model", request.model);
			}
		} else {
			args.push("--model", request.model);
		}
	}
	if (context.systemPromptFile) args.push("--append-system-prompt", context.systemPromptFile);
	args.push(request.action);
	return args;
}

function resolvePiCommandSpec(): PiCommandSpec {
	const explicitCommand = process.env.PI_THREADS_PI_COMMAND?.trim();
	if (explicitCommand) return { command: explicitCommand, argsPrefix: [] };

	const entryPoint = process.argv[1];
	if (entryPoint) {
		const resolvedEntryPoint = path.resolve(entryPoint);
		if (fs.existsSync(resolvedEntryPoint)) {
			const extension = path.extname(resolvedEntryPoint).toLowerCase();
			if (EXECUTABLE_SCRIPT_EXTENSIONS.has(extension)) {
				return {
					command: process.execPath,
					argsPrefix: [resolvedEntryPoint],
				};
			}
			return {
				command: resolvedEntryPoint,
				argsPrefix: [],
			};
		}
	}

	return { command: DEFAULT_PI_COMMAND, argsPrefix: [] };
}

function asExitedState(state: RunState, exitCode: number | null, signal: NodeJS.Signals | null): ExitedRunState {
	if (state.tag === "exited") return state;
	if (state.tag === "running") return { tag: "exited", pid: state.pid, exitCode, signal };
	if (state.tag === "terminating") {
		return {
			tag: "exited",
			pid: state.pid,
			exitCode,
			signal,
			requestedTerminationReason: state.reason,
		};
	}
	return { tag: "exited", exitCode, signal };
}

function createCancelledResult(
	request: PiActorInvocationRequest,
	reason: RunTerminationReason,
	errorMessage?: string,
): PiActorResult {
	return {
		runId: request.runId,
		thread: request.thread,
		finalState: {
			tag: "exited",
			exitCode: null,
			signal: null,
			requestedTerminationReason: reason,
		},
		messages: [],
		stderr: "",
		usage: { ...EMPTY_PI_ACTOR_USAGE_STATS },
		model: request.model,
		stopReason: reason === "abort" ? "aborted" : "error",
		errorMessage,
	};
}

function createInvocation(options: InvocationOptions): PiActorHandle {
	const { request, command, argsBuilder, sigtermGraceMs, waitForTurn, releaseTurn, signal } = options;
	const listeners = new Set<(event: PiActorEvent) => void>();
	const messages: RuntimeMessage[] = [];
	const usage: PiActorUsageStats = { ...EMPTY_PI_ACTOR_USAGE_STATS };

	let child: ChildProcess | null = null;
	let state: RunState = INITIAL_RUN_STATE;
	let startedAt = Date.now();
	let stderr = "";
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let requestedTerminationReason: RunTerminationReason | undefined;
	let terminationPromise: Promise<void> | null = null;
	let cancelQueuedWait: ((reason: RunTerminationReason) => void) | null = null;

	const queuedCancellation = new Promise<RunTerminationReason>((resolve) => {
		cancelQueuedWait = resolve;
	});

	const emit = (event: PiActorEvent) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				/* ignore listener errors */
			}
		}
	};

	const setState = (next: RunState) => {
		state = next;
		emit({ type: "state", state: next });
	};

	const moveToStarted = (pid: number) => {
		if (state.tag !== "queued") return;
		setState(transitionRunState(state, { type: "started", pid }));
	};

	const moveToTerminating = (reason: RunTerminationReason) => {
		if (typeof child?.pid === "number" && state.tag === "queued") {
			moveToStarted(child.pid);
		}
		if (state.tag !== "running") return;
		setState(transitionRunState(state, { type: "terminationRequested", reason }));
	};

	const moveToExited = (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
		let next = asExitedState(state, exitCode, signalCode);
		if (requestedTerminationReason && !next.requestedTerminationReason) {
			next = {
				...next,
				requestedTerminationReason,
			};
		}
		setState(next);
	};

	const handleMessage = (message: RuntimeMessage) => {
		messages.push(message);
		if (message.role === "assistant") {
			usage.turns += 1;
			if (message.usage) {
				usage.input += toNumber(message.usage.input);
				usage.output += toNumber(message.usage.output);
				usage.cacheRead += toNumber(message.usage.cacheRead);
				usage.cacheWrite += toNumber(message.usage.cacheWrite);
				usage.cost += toNumber(message.usage.cost?.total);
				const tokens = toNumber(message.usage.totalTokens);
				if (tokens > 0) usage.contextTokens = tokens;
			}
		}

		if (!model && typeof message.model === "string") model = message.model;
		if (typeof message.stopReason === "string") stopReason = message.stopReason;
		if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
		emit({ type: "message", message });
	};

	const wireOutput = (proc: ChildProcess): (() => void) => {
		let stdoutBuffer = "";

		if (proc.stdout) {
			proc.stdout.on("data", (chunk: Buffer | string) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line) as StreamEvent;
						if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
							handleMessage(event.message);
						}
					} catch {
						/* ignore malformed JSON lines */
					}
				}
			});
		}

		if (proc.stderr) {
			proc.stderr.on("data", (chunk: Buffer | string) => {
				const text = chunk.toString();
				stderr += text;
				emit({ type: "stderr", chunk: text });
			});
		}

		return () => {
			if (!stdoutBuffer.trim()) return;
			try {
				const event = JSON.parse(stdoutBuffer) as StreamEvent;
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					handleMessage(event.message);
				}
			} catch {
				/* ignore trailing non-json */
			}
		};
	};

	const requestTermination = async (reason: RunTerminationReason): Promise<void> => {
		if (!child || getExitSnapshot(child)) return;
		moveToTerminating(reason);
		await terminateProcess(child, { sigtermGraceMs });
	};

	const cancel = async (reason: RunTerminationReason = "abort"): Promise<void> => {
		requestedTerminationReason ??= reason;
		if (state.tag === "exited") return;
		if (!child) {
			cancelQueuedWait?.(requestedTerminationReason);
			cancelQueuedWait = null;
			return;
		}
		if (!terminationPromise) {
			terminationPromise = requestTermination(requestedTerminationReason);
		}
		await terminationPromise;
	};

	const getSnapshot = (): PiActorSnapshot => ({
		runId: request.runId,
		thread: request.thread,
		pid: child?.pid,
		startedAt,
		state,
	});

	const result = (async (): Promise<PiActorResult> => {
		let promptFile: PromptFile | null = null;
		let removeAbortListener: (() => void) | undefined;
		let finalExitCode: number | null = null;
		let finalSignal: NodeJS.Signals | null = null;

		try {
			if (signal) {
				const onAbort = () => {
					void cancel("abort");
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}

			const queuedReason = await Promise.race([
				waitForTurn.then(() => undefined as RunTerminationReason | undefined),
				queuedCancellation.then((reason) => reason),
			]);
			cancelQueuedWait = null;

			if (queuedReason) {
				requestedTerminationReason ??= queuedReason;
				const cancelled = createCancelledResult(request, queuedReason);
				setState(cancelled.finalState);
				return cancelled;
			}

			const sessionPath = resolveSessionPath(request);
			ensureSessionDirectory(sessionPath);
			if (request.systemPrompt) promptFile = writePromptFile(request.systemPrompt);

			const args = argsBuilder(request, {
				sessionPath,
				systemPromptFile: promptFile?.filePath,
			});
			child = spawn(command, args, {
				cwd: request.cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			startedAt = Date.now();

			if (typeof child.pid === "number") moveToStarted(child.pid);
			if (requestedTerminationReason) void cancel(requestedTerminationReason);

			const flushStdout = wireOutput(child);
			const closePromise = waitForClose(child).then(() => {
				flushStdout();
			});

			const exited = await waitForExit(child);
			finalExitCode = exited.exitCode;
			finalSignal = exited.signal;
			moveToExited(finalExitCode, finalSignal);
			await closePromise;

			if (!stopReason && finalExitCode !== null && finalExitCode !== 0) {
				stopReason = "error";
			}
		} catch (error) {
			errorMessage ??= toErrorMessage(error);
			stopReason ??= requestedTerminationReason === "abort" || signal?.aborted || isAbortError(error)
				? "aborted"
				: "error";

			const exited = child ? getExitSnapshot(child) : null;
			finalExitCode = exited?.exitCode ?? finalExitCode;
			finalSignal = exited?.signal ?? finalSignal;
			moveToExited(finalExitCode, finalSignal);
		} finally {
			removeAbortListener?.();
			cleanupPromptFile(promptFile);
			releaseTurn();
		}

		const finalState = asExitedState(state, finalExitCode, finalSignal);
		state = finalState;
		if (!stopReason && finalState.requestedTerminationReason === "abort") {
			stopReason = "aborted";
		}

		return {
			runId: request.runId,
			thread: request.thread,
			finalState,
			messages,
			stderr,
			usage,
			model: model ?? request.model,
			stopReason,
			errorMessage,
		};
	})();

	return {
		runId: request.runId,
		thread: request.thread,
		result,
		cancel,
		subscribe(listener: (event: PiActorEvent) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot,
	};
}

export class PiActorRuntime {
	private readonly command: string;
	private readonly argsBuilder: PiActorArgsBuilder;
	private readonly defaultSigtermGraceMs: number;
	private readonly sessionQueues = new Map<string, Promise<void>>();

	constructor(options: PiActorRuntimeOptions = {}) {
		const commandSpec = options.command
			? { command: options.command, argsPrefix: [] }
			: resolvePiCommandSpec();
		const baseArgsBuilder = options.buildArgs ?? defaultArgsBuilder;

		this.command = commandSpec.command;
		this.argsBuilder = (request, context) => [
			...commandSpec.argsPrefix,
			...baseArgsBuilder(request, context),
		];
		this.defaultSigtermGraceMs = options.defaultSigtermGraceMs ?? 5_000;
	}

	invoke(request: PiActorInvocationRequest, options: PiActorInvokeOptions = {}): PiActorHandle {
		const sessionKey = resolveSessionPath(request);
		const previous = this.sessionQueues.get(sessionKey)?.catch(() => undefined) ?? Promise.resolve();

		let releaseTurn!: () => void;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const queueTail = previous.then(() => turnGate);
		this.sessionQueues.set(sessionKey, queueTail);

		return createInvocation({
			request,
			command: this.command,
			argsBuilder: this.argsBuilder,
			sigtermGraceMs: this.defaultSigtermGraceMs,
			waitForTurn: previous,
			releaseTurn: () => {
				releaseTurn();
				if (this.sessionQueues.get(sessionKey) === queueTail) {
					this.sessionQueues.delete(sessionKey);
				}
			},
			signal: options.signal,
		});
	}
}
