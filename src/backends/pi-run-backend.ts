import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ThreadActorSupervisor } from "../actors/thread-supervisor";
import type { ActorInstance, ThreadName } from "../actors/types";
import {
	INITIAL_RUN_STATE,
	transitionRunState,
	type ExitedRunState,
	type RunEvent,
	type RunState,
	type RunTerminationReason,
} from "../run/state-machine";
import type { EpisodeMessage } from "../episode/builder";
import { ProcessActorBackend } from "./process-actor-backend";
import {
	EMPTY_RUN_USAGE_STATS,
	type RunBackendRequest,
	type RunBackendResult,
	type RunBackendRunOptions,
	type RunUsageStats,
	type TerminableRunBackend,
} from "./run-backend";

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

interface ActiveRunContext {
	thread: ThreadName;
	actorId: string;
	requestTermination: (reason: RunTerminationReason) => Promise<void>;
}

export interface PiRunBackendArgsContext {
	sessionPath: string;
	systemPromptFile?: string;
}

export type PiRunBackendArgsBuilder = (request: RunBackendRequest, context: PiRunBackendArgsContext) => string[];

export interface PiRunBackendOptions {
	command?: string;
	buildArgs?: PiRunBackendArgsBuilder;
	defaultSigtermGraceMs?: number;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	if (!(error instanceof Error)) return false;
	return /abort/i.test(error.message);
}

function parseNumeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function copyUsageStats(): RunUsageStats {
	return {
		input: EMPTY_RUN_USAGE_STATS.input,
		output: EMPTY_RUN_USAGE_STATS.output,
		cacheRead: EMPTY_RUN_USAGE_STATS.cacheRead,
		cacheWrite: EMPTY_RUN_USAGE_STATS.cacheWrite,
		cost: EMPTY_RUN_USAGE_STATS.cost,
		contextTokens: EMPTY_RUN_USAGE_STATS.contextTokens,
		turns: EMPTY_RUN_USAGE_STATS.turns,
	};
}

function ensureExitedState(
	state: RunState,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
): ExitedRunState {
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

function makeSessionPath(cwd: string, sessionKey: string): string {
	const safe = sessionKey.replace(/[^\w.-]+/g, "_");
	const dir = path.join(cwd, THREADS_DIR);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return path.join(dir, `${safe}.jsonl`);
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

function defaultArgsBuilder(request: RunBackendRequest, context: PiRunBackendArgsContext): string[] {
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

function maybeTrackAssistantMessage(
	message: MessageWithRuntimeFields,
	usage: RunUsageStats,
): void {
	if (message.role !== "assistant") return;

	usage.turns += 1;
	if (message.usage) {
		usage.input += parseNumeric(message.usage.input);
		usage.output += parseNumeric(message.usage.output);
		usage.cacheRead += parseNumeric(message.usage.cacheRead);
		usage.cacheWrite += parseNumeric(message.usage.cacheWrite);
		usage.cost += parseNumeric(message.usage.cost?.total);
		const contextTokens = parseNumeric(message.usage.totalTokens);
		if (contextTokens > 0) {
			usage.contextTokens = contextTokens;
		}
	}
}

export class PiRunBackend implements TerminableRunBackend<EpisodeMessage> {
	readonly name = "pi-run-backend";

	private readonly supervisor: ThreadActorSupervisor;
	private readonly command: string;
	private readonly argsBuilder: PiRunBackendArgsBuilder;
	private readonly defaultSigtermGraceMs: number;
	private readonly activeRuns = new Map<string, ActiveRunContext>();

	constructor(options: PiRunBackendOptions = {}) {
		this.command = options.command ?? DEFAULT_PI_COMMAND;
		this.argsBuilder = options.buildArgs ?? defaultArgsBuilder;
		this.defaultSigtermGraceMs = options.defaultSigtermGraceMs ?? 5_000;
		this.supervisor = new ThreadActorSupervisor(
			new ProcessActorBackend({ defaultSigtermGraceMs: this.defaultSigtermGraceMs }),
		);
	}

	async run(
		request: RunBackendRequest,
		options: RunBackendRunOptions<EpisodeMessage> = {},
	): Promise<RunBackendResult<EpisodeMessage>> {
		const thread = request.sessionKey?.trim() || request.runId;

		try {
			return await this.supervisor.runSerialized(
				thread,
				() => this.executeRun(request, thread, options),
				options.signal,
			);
		} catch (error) {
			const stopReason = options.signal?.aborted || isAbortError(error) ? "aborted" : "error";
			return {
				runId: request.runId,
				finalState: {
					tag: "exited",
					exitCode: null,
					signal: null,
					...(stopReason === "aborted" ? { requestedTerminationReason: "abort" } : {}),
				},
				messages: [],
				stderr: "",
				usage: copyUsageStats(),
				model: request.model,
				stopReason,
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async terminate(runId: string): Promise<void> {
		const activeRun = this.activeRuns.get(runId);
		if (!activeRun) return;
		await activeRun.requestTermination("abort");
	}

	private async executeRun(
		request: RunBackendRequest,
		thread: ThreadName,
		options: RunBackendRunOptions<EpisodeMessage>,
	): Promise<RunBackendResult<EpisodeMessage>> {
		let state: RunState = INITIAL_RUN_STATE;
		const messages: MessageWithRuntimeFields[] = [];
		const usage = copyUsageStats();
		let stderr = "";
		let model: string | undefined;
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let finalExitCode: number | null = null;
		let finalSignal: NodeJS.Signals | null = null;

		let actor: ActorInstance | undefined;
		let actorId: string | undefined;
		let promptFile: TempFile | null = null;
		let removeAbortListener: (() => void) | null = null;

		const observer = options.observer;

		const applyEvent = (event: RunEvent) => {
			const previous = state;
			let next = state;

			switch (event.type) {
				case "started":
					if (state.tag === "queued") {
						next = transitionRunState(state, event);
					}
					break;
				case "terminationRequested":
					if (state.tag === "running") {
						next = transitionRunState(state, event);
					}
					break;
				case "exited":
					if (state.tag === "running" || state.tag === "terminating") {
						next = transitionRunState(state, event);
					} else {
						next = ensureExitedState(state, event.exitCode, event.signal);
					}
					break;
			}

			state = next;
			observer?.onStateChange?.({ previous, event, next });
		};

		let terminationPromise: Promise<void> | null = null;
		let terminationRequested = false;

		const requestTermination = async (reason: RunTerminationReason) => {
			if (terminationRequested) return;
			terminationRequested = true;

			if (state.tag === "queued" && actor?.child.pid) {
				applyEvent({ type: "started", pid: actor.child.pid });
			}
			if (state.tag === "running") {
				applyEvent({ type: "terminationRequested", reason });
			}

			if (!actorId) return;
			await this.supervisor.terminateActor(actorId, reason);
		};

		try {
			const sessionPath = makeSessionPath(request.cwd, request.sessionKey?.trim() || request.runId);

			if (request.systemPrompt) {
				promptFile = writePromptFile(request.systemPrompt);
			}

			const args = this.argsBuilder(request, {
				sessionPath,
				systemPromptFile: promptFile?.filePath,
			});

			actorId = `${request.runId}::run`;
			actor = await this.supervisor.startActor({
				actorId,
				thread,
				command: this.command,
				args,
				cwd: request.cwd,
				env: process.env,
				termination: { sigtermGraceMs: this.defaultSigtermGraceMs },
			});

			if (typeof actor.child.pid === "number") {
				applyEvent({ type: "started", pid: actor.child.pid });
			}

			this.activeRuns.set(request.runId, {
				thread,
				actorId,
				requestTermination,
			});

			const onAbort = () => {
				terminationPromise = requestTermination("abort").catch(() => undefined);
			};

			if (options.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
			}

			const child = actor.child;
			let stdoutBuffer = "";

			const processEventLine = (line: string) => {
				if (!line.trim()) return;
				let event: StreamEvent;
				try {
					event = JSON.parse(line) as StreamEvent;
				} catch {
					return;
				}

				if ((event.type !== "message_end" && event.type !== "tool_result_end") || !event.message) return;

				messages.push(event.message);
				maybeTrackAssistantMessage(event.message, usage);

				if (!model && typeof event.message.model === "string") {
					model = event.message.model;
				}
				if (typeof event.message.stopReason === "string") {
					stopReason = event.message.stopReason;
				}
				if (typeof event.message.errorMessage === "string") {
					errorMessage = event.message.errorMessage;
				}

				observer?.onMessage?.(event.message);
			};

			if (child.stdout) {
				child.stdout.on("data", (chunk: Buffer) => {
					stdoutBuffer += chunk.toString();
					const lines = stdoutBuffer.split("\n");
					stdoutBuffer = lines.pop() || "";
					for (const line of lines) processEventLine(line);
				});

				const flushStdoutBuffer = () => {
					if (!stdoutBuffer.trim()) return;
					processEventLine(stdoutBuffer);
					stdoutBuffer = "";
				};

				child.stdout.on("end", flushStdoutBuffer);
				child.stdout.on("close", flushStdoutBuffer);
			}

			if (child.stderr) {
				child.stderr.on("data", (chunk: Buffer) => {
					const text = chunk.toString();
					stderr += text;
					observer?.onStderr?.(text);
				});
			}

			const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
				child.once("close", (code, signal) => {
					resolve({ code, signal });
				});
			});

			const snapshot = await actor.waitForExit();
			if (terminationPromise) await terminationPromise;
			const closed = await closePromise;

			finalExitCode = snapshot.exitCode ?? closed.code;
			finalSignal = snapshot.exitSignal ?? closed.signal;

			applyEvent({
				type: "exited",
				exitCode: finalExitCode,
				signal: finalSignal,
			});

			if (!stopReason && finalExitCode !== null && finalExitCode !== 0) {
				stopReason = "error";
			}
		} catch (error) {
			if (actor && actorId && actor.child.exitCode === null && actor.child.signalCode === null) {
				try {
					await requestTermination("error");
				} catch {
					/* best effort */
				}
			}

			if (actor) {
				const snapshot = await actor.waitForExit();
				finalExitCode = snapshot.exitCode;
				finalSignal = snapshot.exitSignal;
				applyEvent({ type: "exited", exitCode: finalExitCode, signal: finalSignal });
			}

			if (!errorMessage) {
				errorMessage = error instanceof Error ? error.message : String(error);
			}
			if (!stopReason) {
				stopReason = options.signal?.aborted || isAbortError(error) ? "aborted" : "error";
			}
		} finally {
			removeAbortListener?.();
			if (actorId) {
				this.activeRuns.delete(request.runId);
				this.supervisor.removeActor(actorId);
			}
			cleanupPromptFile(promptFile);
		}

		const finalState = ensureExitedState(state, finalExitCode, finalSignal);
		if (!stopReason && finalState.requestedTerminationReason === "abort") {
			stopReason = "aborted";
		}

		return {
			runId: request.runId,
			finalState,
			messages,
			stderr,
			usage,
			model: model ?? request.model,
			stopReason,
			errorMessage,
		};
	}
}
