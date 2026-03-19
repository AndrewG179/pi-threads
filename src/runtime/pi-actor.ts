import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { EpisodeMessage } from "../episode/builder";
import {
	INITIAL_RUN_STATE,
	transitionRunState,
	type ExitedRunState,
	type RunEvent,
	type RunState,
	type RunTerminationReason,
} from "../run/state-machine";
import { terminateProcess } from "./termination";

const THREADS_DIR = ".pi/threads";
const DEFAULT_PI_COMMAND = "pi";

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
	| { type: "state"; previous: RunState; event: RunEvent; next: RunState }
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
	const dir = path.join(cwd, THREADS_DIR);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${safe}.jsonl`);
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
	if (request.model) args.push("--model", request.model);
	if (context.systemPromptFile) args.push("--append-system-prompt", context.systemPromptFile);
	args.push(request.action);
	return args;
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

function createInvocation(params: {
	request: PiActorInvocationRequest;
	signal?: AbortSignal;
	command: string;
	argsBuilder: PiActorArgsBuilder;
	sigtermGraceMs: number;
}): PiActorHandle {
	const { request, signal, command, argsBuilder, sigtermGraceMs } = params;
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

	const emit = (event: PiActorEvent) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				/* ignore listener errors */
			}
		}
	};

	const applyStateEvent = (event: RunEvent) => {
		const previous = state;
		let next = state;

		if (state.tag === "queued" && event.type === "started") {
			next = transitionRunState(state, event);
		} else if (state.tag === "running" && event.type === "terminationRequested") {
			next = transitionRunState(state, event);
		} else if (state.tag === "running" && event.type === "exited") {
			next = transitionRunState(state, event);
		} else if (state.tag === "terminating" && event.type === "exited") {
			next = transitionRunState(state, event);
		} else if (event.type === "exited") {
			next = asExitedState(state, event.exitCode, event.signal);
		}

		if (next === state) return;
		state = next;
		emit({ type: "state", previous, event, next });
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
					let event: StreamEvent;
					try {
						event = JSON.parse(line) as StreamEvent;
					} catch {
						continue;
					}
					if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
						handleMessage(event.message);
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
			stdoutBuffer = "";
		};
	};

	const requestTermination = async (reason: RunTerminationReason): Promise<void> => {
		if (!child || getExitSnapshot(child)) return;
		if (typeof child.pid === "number") applyStateEvent({ type: "started", pid: child.pid });
		applyStateEvent({ type: "terminationRequested", reason });
		await terminateProcess(child, { sigtermGraceMs });
	};

	const cancel = async (reason: RunTerminationReason = "abort"): Promise<void> => {
		requestedTerminationReason ??= reason;
		if (state.tag === "exited") return;
		if (!child) return;
		if (!terminationPromise) {
			terminationPromise = requestTermination(requestedTerminationReason);
		}
		await terminationPromise;
	};

	const result = (async (): Promise<PiActorResult> => {
		let promptFile: PromptFile | null = null;
		let removeAbortListener: (() => void) | undefined;
		let finalExitCode: number | null = null;
		let finalSignal: NodeJS.Signals | null = null;

		try {
			const sessionPath = request.sessionPath ?? makeSessionPath(request.cwd, request.thread);
			if (request.systemPrompt) promptFile = writePromptFile(request.systemPrompt);

			const args = argsBuilder(request, {
				sessionPath,
				systemPromptFile: promptFile?.filePath,
			});
			child = spawn(command, args, {
				cwd: request.cwd,
				env: process.env,
				stdio: "pipe",
				shell: false,
			});
			startedAt = Date.now();

			if (typeof child.pid === "number") applyStateEvent({ type: "started", pid: child.pid });
			if (requestedTerminationReason) void cancel(requestedTerminationReason);

			if (signal) {
				const onAbort = () => {
					void cancel("abort");
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}

			const flushStdout = wireOutput(child);
			const closePromise = waitForClose(child).then(() => {
				flushStdout();
			});

			const exited = await waitForExit(child);
			finalExitCode = exited.exitCode;
			finalSignal = exited.signal;
			applyStateEvent({ type: "exited", exitCode: finalExitCode, signal: finalSignal });
			await closePromise;

			if (!stopReason && finalExitCode !== null && finalExitCode !== 0) {
				stopReason = "error";
			}
		} catch (error) {
			errorMessage ??= toErrorMessage(error);
			stopReason ??= signal?.aborted || isAbortError(error) ? "aborted" : "error";

			const exited = child ? getExitSnapshot(child) : null;
			if (exited) {
				finalExitCode = exited.exitCode;
				finalSignal = exited.signal;
				applyStateEvent({ type: "exited", exitCode: finalExitCode, signal: finalSignal });
			} else if (requestedTerminationReason === "abort") {
				applyStateEvent({ type: "exited", exitCode: null, signal: null });
			}
		} finally {
			removeAbortListener?.();
			cleanupPromptFile(promptFile);
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
		getSnapshot(): PiActorSnapshot {
			return {
				runId: request.runId,
				thread: request.thread,
				pid: child?.pid,
				startedAt,
				state,
			};
		},
	};
}

export class PiActorRuntime {
	private readonly command: string;
	private readonly argsBuilder: PiActorArgsBuilder;
	private readonly defaultSigtermGraceMs: number;

	constructor(options: PiActorRuntimeOptions = {}) {
		this.command = options.command ?? DEFAULT_PI_COMMAND;
		this.argsBuilder = options.buildArgs ?? defaultArgsBuilder;
		this.defaultSigtermGraceMs = options.defaultSigtermGraceMs ?? 5_000;
	}

	invoke(request: PiActorInvocationRequest, options: PiActorInvokeOptions = {}): PiActorHandle {
		return createInvocation({
			request,
			signal: options.signal,
			command: this.command,
			argsBuilder: this.argsBuilder,
			sigtermGraceMs: this.defaultSigtermGraceMs,
		});
	}
}
