import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { EpisodeMessage } from "../episode/builder";
import { getThreadSessionPath } from "../subagents/metadata";

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

interface ProtocolErrorHandlers {
	onMalformedOutput(error: Error): void;
}

type PromptFile = {
	dir: string;
	filePath: string;
};

type ExitSnapshot = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
};

interface PiActorUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

const EMPTY_USAGE_STATS: PiActorUsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

interface PiActorInvocationRequest {
	runId: string;
	thread: string;
	cwd: string;
	action: string;
	model?: string;
	systemPrompt?: string;
	sessionPath?: string;
}

interface PiActorArgsContext {
	sessionPath: string;
	systemPromptFile?: string;
}

type PiActorArgsBuilder = (request: PiActorInvocationRequest, context: PiActorArgsContext) => string[];

interface PiActorRuntimeOptions {
	command?: string;
	buildArgs?: PiActorArgsBuilder;
}

interface PiCommandSpec {
	command: string;
	argsPrefix: string[];
}

interface PiActorFinalState {
	tag: "exited";
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

interface PiActorResult {
	runId: string;
	thread: string;
	finalState: PiActorFinalState;
	messages: readonly EpisodeMessage[];
	stderr: string;
	usage: PiActorUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

type PiActorEvent =
	| { type: "message"; message: EpisodeMessage }
	| { type: "stderr"; chunk: string };

interface PiActorHandle {
	readonly result: Promise<PiActorResult>;
	subscribe(listener: (event: PiActorEvent) => void): () => void;
	cancel(): void | Promise<void>;
}

interface SessionTurn {
	ready: Promise<void>;
	release(): void;
}

function toNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function summarizeProtocolOutput(output: string): string {
	const normalized = output.replace(/\s+/g, " ").trim();
	if (!normalized) return "(blank output)";
	return normalized.length > 200 ? `${normalized.slice(0, 199)}…` : normalized;
}

function createMalformedProtocolError(output: string): Error {
	return new Error(`Worker emitted malformed --mode json output: ${summarizeProtocolOutput(output)}`);
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

function ensureSessionDirectory(sessionPath: string): void {
	const dir = path.dirname(sessionPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getInvocationSessionPath(
	request: Pick<PiActorInvocationRequest, "cwd" | "thread" | "sessionPath">,
): string {
	return request.sessionPath ?? getThreadSessionPath(path.join(request.cwd, THREADS_DIR), request.thread);
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

function buildDefaultPiActorArgs(request: PiActorInvocationRequest, context: PiActorArgsContext): string[] {
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
			return { command: resolvedEntryPoint, argsPrefix: [] };
		}
	}

	return { command: DEFAULT_PI_COMMAND, argsPrefix: [] };
}

function createFinalState(exitCode: number | null, signal: NodeJS.Signals | null): PiActorFinalState {
	return { tag: "exited", exitCode, signal };
}

function createAbortedResult(request: PiActorInvocationRequest): PiActorResult {
	return {
		runId: request.runId,
		thread: request.thread,
		finalState: createFinalState(1, null),
		messages: [],
		stderr: "",
		usage: { ...EMPTY_USAGE_STATS },
		model: request.model,
		stopReason: "aborted",
	};
}

function killChild(child: ChildProcess | null): void {
	if (!child) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		/* ignore kill failures */
	}
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function parseStreamEvent(output: string): RuntimeMessage | undefined {
	const event = JSON.parse(output) as StreamEvent;
	if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
		return event.message;
	}
	return undefined;
}

function wireOutput(
	child: ChildProcess,
	onMessage: (message: RuntimeMessage) => void,
	onStderr: (chunk: string) => void,
	handlers: ProtocolErrorHandlers,
): () => void {
	let stdoutBuffer = "";
	let protocolBroken = false;

	const handleProtocolOutput = (output: string) => {
		if (protocolBroken || !output.trim()) return;
		try {
			const message = parseStreamEvent(output);
			if (message) onMessage(message);
		} catch {
			protocolBroken = true;
			handlers.onMalformedOutput(createMalformedProtocolError(output));
		}
	};

	if (child.stdout) {
		child.stdout.on("data", (chunk: Buffer | string) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) {
				handleProtocolOutput(line);
			}
		});
	}

	if (child.stderr) {
		child.stderr.on("data", (chunk: Buffer | string) => {
			onStderr(chunk.toString());
		});
	}

	return () => {
		handleProtocolOutput(stdoutBuffer);
	};
}

async function runInvocation(params: {
	request: PiActorInvocationRequest;
	sessionPath: string;
	command: string;
	argsBuilder: PiActorArgsBuilder;
	emit: (event: PiActorEvent) => void;
	signal: AbortSignal;
	setChild(child: ChildProcess | null): void;
}): Promise<PiActorResult> {
	const { request, sessionPath, command, argsBuilder, emit, signal, setChild } = params;
	const messages: RuntimeMessage[] = [];
	const usage: PiActorUsageStats = { ...EMPTY_USAGE_STATS };
	let promptFile: PromptFile | null = null;
	let stderr = "";
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let finalExitCode: number | null = null;
	let finalSignal: NodeJS.Signals | null = null;
	let cleanupAbortListener = () => {};
	let protocolError: Error | undefined;

	const resetPartialState = () => {
		messages.length = 0;
		usage.input = 0;
		usage.output = 0;
		usage.cacheRead = 0;
		usage.cacheWrite = 0;
		usage.cost = 0;
		usage.contextTokens = 0;
		usage.turns = 0;
		model = undefined;
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

	try {
		if (signal.aborted) {
			return createAbortedResult(request);
		}

		ensureSessionDirectory(sessionPath);
		if (request.systemPrompt) promptFile = writePromptFile(request.systemPrompt);

		const child = spawn(command, argsBuilder(request, {
			sessionPath,
			systemPromptFile: promptFile?.filePath,
		}), {
			cwd: request.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		setChild(child);

		const flushStdout = wireOutput(
			child,
			handleMessage,
			(chunk) => {
				stderr += chunk;
				emit({ type: "stderr", chunk });
			},
			{
				onMalformedOutput(error) {
					if (protocolError) return;
					protocolError = error;
					resetPartialState();
					errorMessage = error.message;
					stopReason = "error";
					killChild(child);
				},
			},
		);

		const onAbort = () => {
			stopReason = "aborted";
			killChild(child);
		};
		signal.addEventListener("abort", onAbort);
		cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
		if (signal.aborted) onAbort();

		const closePromise = waitForClose(child).then(() => {
			flushStdout();
		});

		const exited = await waitForExit(child);
		finalExitCode = exited.exitCode;
		finalSignal = exited.signal;
		await closePromise;

		if (signal.aborted) {
			stopReason = "aborted";
			if (finalExitCode === null && finalSignal === null) finalExitCode = 1;
		} else if (protocolError) {
			stopReason = "error";
			errorMessage = protocolError.message;
			if (finalExitCode === null || finalExitCode === 0) finalExitCode = 1;
		} else if (!stopReason && finalExitCode !== null && finalExitCode !== 0) {
			stopReason = "error";
		}
	} catch (error) {
		if (signal.aborted) {
			stopReason = "aborted";
			finalExitCode ??= 1;
		} else {
			errorMessage = toErrorMessage(error);
			stopReason = "error";
			finalExitCode ??= 1;
		}
	} finally {
		cleanupAbortListener();
		setChild(null);
		cleanupPromptFile(promptFile);
	}

	return {
		runId: request.runId,
		thread: request.thread,
		finalState: createFinalState(finalExitCode, finalSignal),
		messages,
		stderr,
		usage,
		model: model ?? request.model,
		stopReason,
		errorMessage,
	};
}

export class PiActorRuntime {
	private readonly command: string;
	private readonly argsBuilder: PiActorArgsBuilder;
	private readonly sessionQueues = new Map<string, Promise<void>>();

	constructor(options: PiActorRuntimeOptions = {}) {
		const commandSpec = options.command
			? { command: options.command, argsPrefix: [] }
			: resolvePiCommandSpec();
		const baseArgsBuilder = options.buildArgs ?? buildDefaultPiActorArgs;

		this.command = commandSpec.command;
		this.argsBuilder = (request, context) => [
			...commandSpec.argsPrefix,
			...baseArgsBuilder(request, context),
		];
	}

	private claimSessionTurn(sessionPath: string): SessionTurn {
		const previous = this.sessionQueues.get(sessionPath)?.catch(() => undefined) ?? Promise.resolve();

		let releaseTurn!: () => void;
		const current = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const queueTail = previous.then(() => current);
		this.sessionQueues.set(sessionPath, queueTail);

		return {
			ready: previous,
			release: () => {
				releaseTurn();
				void queueTail.finally(() => {
					if (this.sessionQueues.get(sessionPath) === queueTail) {
						this.sessionQueues.delete(sessionPath);
					}
				});
			},
		};
	}

	invoke(request: PiActorInvocationRequest): PiActorHandle {
		const listeners = new Set<(event: PiActorEvent) => void>();
		const controller = new AbortController();
		let child: ChildProcess | null = null;
		const emit = (event: PiActorEvent) => {
			for (const listener of listeners) {
				try {
					listener(event);
				} catch {
					/* ignore listener errors */
				}
			}
		};

		const sessionPath = getInvocationSessionPath(request);
		const turn = this.claimSessionTurn(sessionPath);

		const result = (async () => {
			try {
				const gate = await Promise.race([
					turn.ready.then(() => "ready" as const),
					waitForAbort(controller.signal).then(() => "aborted" as const),
				]);
				if (gate === "aborted") {
					return createAbortedResult(request);
				}

				return await runInvocation({
					request,
					sessionPath,
					command: this.command,
					argsBuilder: this.argsBuilder,
					emit,
					signal: controller.signal,
					setChild(nextChild) {
						child = nextChild;
						if (controller.signal.aborted) killChild(child);
					},
				});
			} finally {
				child = null;
				turn.release();
			}
		})();

		return {
			result,
			subscribe(listener: (event: PiActorEvent) => void): () => void {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			cancel(): void {
				if (controller.signal.aborted) return;
				controller.abort();
				killChild(child);
			},
		};
	}
}
