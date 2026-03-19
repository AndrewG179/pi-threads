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

interface TempFile {
	dir: string;
	filePath: string;
}

type MessageWithRuntimeFields = EpisodeMessage & {
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: {
			total?: number;
		};
	};
};

interface StreamEvent {
	type?: string;
	message?: MessageWithRuntimeFields;
}

interface ExitSnapshot {
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
}

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
	| {
			type: "state";
			previous: RunState;
			event: RunEvent;
			next: RunState;
	  }
	| {
			type: "message";
			message: EpisodeMessage;
	  }
	| {
			type: "stderr";
			chunk: string;
	  };

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

function parseNumeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function copyUsageStats(): PiActorUsageStats {
	return {
		input: EMPTY_PI_ACTOR_USAGE_STATS.input,
		output: EMPTY_PI_ACTOR_USAGE_STATS.output,
		cacheRead: EMPTY_PI_ACTOR_USAGE_STATS.cacheRead,
		cacheWrite: EMPTY_PI_ACTOR_USAGE_STATS.cacheWrite,
		cost: EMPTY_PI_ACTOR_USAGE_STATS.cost,
		contextTokens: EMPTY_PI_ACTOR_USAGE_STATS.contextTokens,
		turns: EMPTY_PI_ACTOR_USAGE_STATS.turns,
	};
}

function maybeTrackAssistantMessage(message: MessageWithRuntimeFields, usage: PiActorUsageStats): void {
	if (message.role !== "assistant") return;

	usage.turns += 1;
	if (message.usage) {
		usage.input += parseNumeric(message.usage.input);
		usage.output += parseNumeric(message.usage.output);
		usage.cacheRead += parseNumeric(message.usage.cacheRead);
		usage.cacheWrite += parseNumeric(message.usage.cacheWrite);
		usage.cost += parseNumeric(message.usage.cost?.total);
		const contextTokens = parseNumeric(message.usage.totalTokens);
		if (contextTokens > 0) usage.contextTokens = contextTokens;
	}
}

function writePromptFile(content: string): TempFile {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-thread-worker-"));
	const filePath = path.join(dir, "worker.md");
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function cleanupPromptFile(temp: TempFile | null): void {
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

function makeSessionPath(cwd: string, thread: string): string {
	const safe = thread.replace(/[^\w.-]+/g, "_");
	const dir = path.join(cwd, THREADS_DIR);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return path.join(dir, `${safe}.jsonl`);
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

function ensureExitedState(state: RunState, exitCode: number | null, signal: NodeJS.Signals | null): ExitedRunState {
	if (state.tag === "exited") return state;
	if (state.tag === "terminating") {
		return {
			tag: "exited",
			pid: state.pid,
			exitCode,
			signal,
			requestedTerminationReason: state.reason,
		};
	}
	if (state.tag === "running") {
		return {
			tag: "exited",
			pid: state.pid,
			exitCode,
			signal,
		};
	}
	return {
		tag: "exited",
		exitCode,
		signal,
	};
}

function getExitSnapshot(child: ChildProcess): ExitSnapshot | null {
	if (child.exitCode === null && child.signalCode === null) return null;
	return {
		exitCode: child.exitCode,
		exitSignal: child.signalCode,
	};
}

function waitForProcessExit(child: ChildProcess): Promise<ExitSnapshot> {
	const exited = getExitSnapshot(child);
	if (exited) return Promise.resolve(exited);

	return new Promise<ExitSnapshot>((resolve, reject) => {
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};

		const onExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
			cleanup();
			resolve({ exitCode, exitSignal });
		};

		const cleanup = () => {
			child.off("error", onError);
			child.off("exit", onExit);
		};

		child.once("error", onError);
		child.once("exit", onExit);
	});
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	if (!(error instanceof Error)) return false;
	return /abort/i.test(error.message);
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

class RuntimeInvocation implements PiActorHandle {
	readonly runId: string;
	readonly thread: string;
	readonly result: Promise<PiActorResult>;

	private readonly request: PiActorInvocationRequest;
	private readonly signal: AbortSignal | undefined;
	private readonly command: string;
	private readonly argsBuilder: PiActorArgsBuilder;
	private readonly sigtermGraceMs: number;
	private readonly listeners = new Set<(event: PiActorEvent) => void>();

	private child: ChildProcess | null = null;
	private state: RunState = INITIAL_RUN_STATE;
	private startedAt = Date.now();
	private readonly messages: MessageWithRuntimeFields[] = [];
	private readonly usage = copyUsageStats();
	private stderr = "";
	private model: string | undefined;
	private stopReason: string | undefined;
	private errorMessage: string | undefined;
	private terminationPromise: Promise<void> | null = null;
	private requestedTerminationReason: RunTerminationReason | undefined;

	constructor(params: {
		request: PiActorInvocationRequest;
		signal?: AbortSignal;
		command: string;
		argsBuilder: PiActorArgsBuilder;
		sigtermGraceMs: number;
	}) {
		this.request = params.request;
		this.signal = params.signal;
		this.command = params.command;
		this.argsBuilder = params.argsBuilder;
		this.sigtermGraceMs = params.sigtermGraceMs;
		this.runId = params.request.runId;
		this.thread = params.request.thread;

		this.result = this.execute();
	}

	subscribe(listener: (event: PiActorEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): PiActorSnapshot {
		return {
			runId: this.runId,
			thread: this.thread,
			pid: this.child?.pid ?? undefined,
			startedAt: this.startedAt,
			state: this.state,
		};
	}

	async cancel(reason: RunTerminationReason = "abort"): Promise<void> {
		if (!this.requestedTerminationReason) {
			this.requestedTerminationReason = reason;
		}

		if (this.state.tag === "exited") return;
		if (!this.terminationPromise) {
			this.terminationPromise = this.requestTermination(this.requestedTerminationReason);
		}
		await this.terminationPromise;
	}

	private emit(event: PiActorEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* ignore listener errors */
			}
		}
	}

	private applyEvent(event: RunEvent): void {
		const previous = this.state;
		let next = this.state;

		switch (event.type) {
			case "started":
				if (this.state.tag === "queued") {
					next = transitionRunState(this.state, event);
				}
				break;
			case "terminationRequested":
				if (this.state.tag === "running") {
					next = transitionRunState(this.state, event);
				}
				break;
			case "exited":
				if (this.state.tag === "running" || this.state.tag === "terminating") {
					next = transitionRunState(this.state, event);
				} else {
					next = ensureExitedState(this.state, event.exitCode, event.signal);
				}
				break;
		}

		this.state = next;
		this.emit({ type: "state", previous, event, next });
	}

	private processStdoutLine(line: string): void {
		if (!line.trim()) return;

		let event: StreamEvent;
		try {
			event = JSON.parse(line) as StreamEvent;
		} catch {
			return;
		}

		if ((event.type !== "message_end" && event.type !== "tool_result_end") || !event.message) return;

		this.messages.push(event.message);
		maybeTrackAssistantMessage(event.message, this.usage);
		if (!this.model && typeof event.message.model === "string") {
			this.model = event.message.model;
		}
		if (typeof event.message.stopReason === "string") {
			this.stopReason = event.message.stopReason;
		}
		if (typeof event.message.errorMessage === "string") {
			this.errorMessage = event.message.errorMessage;
		}

		this.emit({ type: "message", message: event.message });
	}

	private async requestTermination(reason: RunTerminationReason): Promise<void> {
		if (!this.child) return;
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;

		if (this.state.tag === "queued" && typeof this.child.pid === "number") {
			this.applyEvent({ type: "started", pid: this.child.pid });
		}
		if (this.state.tag === "running") {
			this.applyEvent({ type: "terminationRequested", reason });
		}

		await terminateProcess(this.child, { sigtermGraceMs: this.sigtermGraceMs });
	}

	private async execute(): Promise<PiActorResult> {
		let promptFile: TempFile | null = null;
		let removeAbortListener: (() => void) | undefined;
		let closePromise: Promise<void> | null = null;
		let finalExitCode: number | null = null;
		let finalSignal: NodeJS.Signals | null = null;

		try {
			const sessionPath = this.request.sessionPath ?? makeSessionPath(this.request.cwd, this.request.thread);
			if (this.request.systemPrompt) {
				promptFile = writePromptFile(this.request.systemPrompt);
			}

			const args = this.argsBuilder(this.request, {
				sessionPath,
				systemPromptFile: promptFile?.filePath,
			});

			this.child = spawn(this.command, args, {
				cwd: this.request.cwd,
				env: process.env,
				stdio: "pipe",
				shell: false,
			});

			this.startedAt = Date.now();
			if (typeof this.child.pid === "number") {
				this.applyEvent({ type: "started", pid: this.child.pid });
			}

			if (this.requestedTerminationReason) {
				void this.cancel(this.requestedTerminationReason);
			}

			if (this.signal) {
				const onAbort = () => {
					void this.cancel("abort");
				};
				if (this.signal.aborted) onAbort();
				else this.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => {
					this.signal?.removeEventListener("abort", onAbort);
				};
			}

			let stdoutBuffer = "";
			if (this.child.stdout) {
				this.child.stdout.on("data", (chunk: Buffer | string) => {
					stdoutBuffer += chunk.toString();
					const lines = stdoutBuffer.split("\n");
					stdoutBuffer = lines.pop() || "";
					for (const line of lines) {
						this.processStdoutLine(line);
					}
				});

				const flushStdoutBuffer = () => {
					if (!stdoutBuffer.trim()) return;
					this.processStdoutLine(stdoutBuffer);
					stdoutBuffer = "";
				};

				this.child.stdout.on("end", flushStdoutBuffer);
				this.child.stdout.on("close", flushStdoutBuffer);
			}

			if (this.child.stderr) {
				this.child.stderr.on("data", (chunk: Buffer | string) => {
					const text = chunk.toString();
					this.stderr += text;
					this.emit({ type: "stderr", chunk: text });
				});
			}

			closePromise = new Promise<void>((resolve) => {
				this.child?.once("close", () => resolve());
			});

			const exitSnapshot = await waitForProcessExit(this.child);
			finalExitCode = exitSnapshot.exitCode;
			finalSignal = exitSnapshot.exitSignal;
			this.applyEvent({ type: "exited", exitCode: finalExitCode, signal: finalSignal });
			if (closePromise) await closePromise;

			if (!this.stopReason && finalExitCode !== null && finalExitCode !== 0) {
				this.stopReason = "error";
			}
		} catch (error) {
			if (!this.errorMessage) {
				this.errorMessage = toErrorMessage(error);
			}

			if (!this.stopReason) {
				this.stopReason = this.signal?.aborted || isAbortError(error) ? "aborted" : "error";
			}

			const childExit = this.child ? getExitSnapshot(this.child) : null;
			if (childExit) {
				finalExitCode = childExit.exitCode;
				finalSignal = childExit.exitSignal;
				this.applyEvent({ type: "exited", exitCode: finalExitCode, signal: finalSignal });
			} else if (this.requestedTerminationReason === "abort") {
				this.applyEvent({ type: "exited", exitCode: null, signal: null });
			}
		} finally {
			removeAbortListener?.();
			cleanupPromptFile(promptFile);
		}

		const finalState = ensureExitedState(this.state, finalExitCode, finalSignal);
		this.state = finalState;

		if (!this.stopReason && finalState.requestedTerminationReason === "abort") {
			this.stopReason = "aborted";
		}

		return {
			runId: this.request.runId,
			thread: this.request.thread,
			finalState,
			messages: this.messages,
			stderr: this.stderr,
			usage: this.usage,
			model: this.model ?? this.request.model,
			stopReason: this.stopReason,
			errorMessage: this.errorMessage,
		};
	}
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
		return new RuntimeInvocation({
			request,
			signal: options.signal,
			command: this.command,
			argsBuilder: this.argsBuilder,
			sigtermGraceMs: this.defaultSigtermGraceMs,
		});
	}
}
