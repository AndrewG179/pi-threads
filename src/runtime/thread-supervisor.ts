import {
	EMPTY_PI_ACTOR_USAGE_STATS,
	PiActorRuntime,
	type PiActorEvent,
	type PiActorHandle,
	type PiActorInvocationRequest,
	type PiActorResult,
	type PiActorSnapshot,
} from "./pi-actor";
import { type RunEvent, type RunTerminationReason, type RunState } from "../run/state-machine";

function createAbortError(): Error {
	const error = new Error("Run was aborted while waiting for thread turn");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	if (!(error instanceof Error)) return false;
	return /abort/i.test(error.message);
}

function waitForPromiseWithSignal(waitFor: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return waitFor;
	if (signal.aborted) return Promise.reject(createAbortError());

	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(createAbortError());
		};

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};

		signal.addEventListener("abort", onAbort, { once: true });

		waitFor.then(
			() => {
				cleanup();
				resolve();
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
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
		usage: {
			input: EMPTY_PI_ACTOR_USAGE_STATS.input,
			output: EMPTY_PI_ACTOR_USAGE_STATS.output,
			cacheRead: EMPTY_PI_ACTOR_USAGE_STATS.cacheRead,
			cacheWrite: EMPTY_PI_ACTOR_USAGE_STATS.cacheWrite,
			cost: EMPTY_PI_ACTOR_USAGE_STATS.cost,
			contextTokens: EMPTY_PI_ACTOR_USAGE_STATS.contextTokens,
			turns: EMPTY_PI_ACTOR_USAGE_STATS.turns,
		},
		model: request.model,
		stopReason: reason === "abort" ? "aborted" : "error",
		errorMessage,
	};
}

export interface ThreadInvokeOptions {
	signal?: AbortSignal;
}

export interface ThreadHandle {
	readonly runId: string;
	readonly thread: string;
	readonly result: Promise<PiActorResult>;
	cancel(reason?: RunTerminationReason): Promise<void>;
	subscribe(listener: (event: PiActorEvent) => void): () => void;
	getSnapshot(): PiActorSnapshot;
}

class SupervisedInvocation implements ThreadHandle {
	readonly runId: string;
	readonly thread: string;
	readonly result: Promise<PiActorResult>;

	private readonly request: PiActorInvocationRequest;
	private readonly runtime: PiActorRuntime;
	private readonly waitForTurn: Promise<void>;
	private readonly releaseTurn: () => void;
	private readonly onSettled: () => void;
	private readonly externalSignal: AbortSignal | undefined;
	private readonly waitAbortController = new AbortController();
	private readonly listeners = new Set<(event: PiActorEvent) => void>();

	private runtimeHandle: PiActorHandle | null = null;
	private state: RunState = { tag: "queued" };
	private startedAt = Date.now();
	private pid: number | undefined;
	private requestedTerminationReason: RunTerminationReason | undefined;
	private removeExternalAbortListener: (() => void) | null = null;

	constructor(params: {
		request: PiActorInvocationRequest;
		runtime: PiActorRuntime;
		waitForTurn: Promise<void>;
		releaseTurn: () => void;
		onSettled: () => void;
		externalSignal?: AbortSignal;
	}) {
		this.request = params.request;
		this.runtime = params.runtime;
		this.waitForTurn = params.waitForTurn;
		this.releaseTurn = params.releaseTurn;
		this.onSettled = params.onSettled;
		this.externalSignal = params.externalSignal;
		this.runId = params.request.runId;
		this.thread = params.request.thread;

		if (this.externalSignal) {
			const onAbort = () => {
				void this.cancel("abort");
			};
			if (this.externalSignal.aborted) onAbort();
			else this.externalSignal.addEventListener("abort", onAbort, { once: true });
			this.removeExternalAbortListener = () => {
				this.externalSignal?.removeEventListener("abort", onAbort);
			};
		}

		this.result = this.execute();
	}

	subscribe(listener: (event: PiActorEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): PiActorSnapshot {
		if (this.runtimeHandle) {
			const runtimeSnapshot = this.runtimeHandle.getSnapshot();
			this.state = runtimeSnapshot.state;
			this.pid = runtimeSnapshot.pid;
			this.startedAt = runtimeSnapshot.startedAt;
		}

		return {
			runId: this.runId,
			thread: this.thread,
			pid: this.pid,
			startedAt: this.startedAt,
			state: this.state,
		};
	}

	async cancel(reason: RunTerminationReason = "abort"): Promise<void> {
		if (!this.requestedTerminationReason) {
			this.requestedTerminationReason = reason;
		}

		if (this.runtimeHandle) {
			await this.runtimeHandle.cancel(this.requestedTerminationReason);
			return;
		}

		this.waitAbortController.abort();
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

	private moveToExited(reason: RunTerminationReason): void {
		if (this.state.tag === "exited") return;
		const previous = this.state;
		const event: RunEvent = { type: "exited", exitCode: null, signal: null };
		const next: RunState = {
			tag: "exited",
			exitCode: null,
			signal: null,
			requestedTerminationReason: reason,
		};
		this.state = next;
		this.emit({ type: "state", previous, event, next });
	}

	private async execute(): Promise<PiActorResult> {
		let unsubscribeForward: (() => void) | null = null;
		try {
			await waitForPromiseWithSignal(this.waitForTurn, this.waitAbortController.signal);

			if (this.requestedTerminationReason) {
				this.moveToExited(this.requestedTerminationReason);
				return createCancelledResult(this.request, this.requestedTerminationReason);
			}

			this.runtimeHandle = this.runtime.invoke(this.request, { signal: this.externalSignal });
			const runtimeSnapshot = this.runtimeHandle.getSnapshot();
			this.state = runtimeSnapshot.state;
			this.pid = runtimeSnapshot.pid;
			this.startedAt = runtimeSnapshot.startedAt;

			unsubscribeForward = this.runtimeHandle.subscribe((event) => {
				if (event.type === "state") {
					this.state = event.next;
					if ("pid" in event.next && typeof event.next.pid === "number") {
						this.pid = event.next.pid;
					}
				}
				this.emit(event);
			});

			if (this.requestedTerminationReason) {
				await this.runtimeHandle.cancel(this.requestedTerminationReason);
			}

			const result = await this.runtimeHandle.result;
			this.state = result.finalState;
			if (result.finalState.pid !== undefined && result.finalState.pid !== null) {
				this.pid = result.finalState.pid;
			}
			return result;
		} catch (error) {
			const reason = this.requestedTerminationReason
				?? (this.externalSignal?.aborted || isAbortError(error) ? "abort" : "error");
			this.moveToExited(reason);
			return createCancelledResult(this.request, reason, toErrorMessage(error));
		} finally {
			unsubscribeForward?.();
			this.removeExternalAbortListener?.();
			this.releaseTurn();
			this.onSettled();
		}
	}
}

/**
 * Minimal supervisor: serialize per-thread invocations, keep different thread
 * names concurrent, and expose cancellation/inspection hooks.
 */
export class ThreadSupervisor {
	private readonly threadQueues = new Map<string, Promise<void>>();
	private readonly activeInvocations = new Map<string, SupervisedInvocation>();

	constructor(private readonly runtime: PiActorRuntime) {}

	invoke(request: PiActorInvocationRequest, options: ThreadInvokeOptions = {}): ThreadHandle {
		if (this.activeInvocations.has(request.runId)) {
			throw new Error(`Run '${request.runId}' is already active`);
		}

		const previous = this.threadQueues.get(request.thread) ?? Promise.resolve();
		const waitForTurn = previous.catch(() => undefined);

		let releaseTurn!: () => void;
		const currentTurn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});

		const queueTail = waitForTurn.then(() => currentTurn);
		this.threadQueues.set(request.thread, queueTail);

		const invocation = new SupervisedInvocation({
			request,
			runtime: this.runtime,
			waitForTurn,
			releaseTurn: () => {
				releaseTurn();
				if (this.threadQueues.get(request.thread) === queueTail) {
					this.threadQueues.delete(request.thread);
				}
			},
			onSettled: () => {
				this.activeInvocations.delete(request.runId);
			},
			externalSignal: options.signal,
		});

		this.activeInvocations.set(request.runId, invocation);
		return invocation;
	}

	inspect(runId: string): PiActorSnapshot | undefined {
		const invocation = this.activeInvocations.get(runId);
		if (!invocation) return undefined;
		return invocation.getSnapshot();
	}

	listActive(): PiActorSnapshot[] {
		return [...this.activeInvocations.values()].map((invocation) => invocation.getSnapshot());
	}

	async cancel(runId: string, reason: RunTerminationReason = "abort"): Promise<boolean> {
		const invocation = this.activeInvocations.get(runId);
		if (!invocation) return false;
		await invocation.cancel(reason);
		return true;
	}
}
