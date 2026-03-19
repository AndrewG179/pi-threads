import {
	EMPTY_PI_ACTOR_USAGE_STATS,
	PiActorRuntime,
	type PiActorEvent,
	type PiActorHandle,
	type PiActorInvocationRequest,
	type PiActorResult,
	type PiActorSnapshot,
} from "./pi-actor";
import { type RunEvent, type RunState, type RunTerminationReason } from "../run/state-machine";

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	return error instanceof Error && /abort/i.test(error.message);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

function createSupervisedInvocation(params: {
	request: PiActorInvocationRequest;
	runtime: PiActorRuntime;
	waitForTurn: Promise<void>;
	releaseTurn: () => void;
	onSettled: () => void;
	externalSignal?: AbortSignal;
}): ThreadHandle {
	const { request, runtime, waitForTurn, releaseTurn, onSettled, externalSignal } = params;
	const listeners = new Set<(event: PiActorEvent) => void>();
	let runtimeHandle: PiActorHandle | null = null;
	let state: RunState = { tag: "queued" };
	let startedAt = Date.now();
	let pid: number | undefined;
	let requestedTerminationReason: RunTerminationReason | undefined;

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

	const moveToExited = (reason: RunTerminationReason) => {
		if (state.tag === "exited") return;
		const previous = state;
		const event: RunEvent = { type: "exited", exitCode: null, signal: null };
		const next: RunState = {
			tag: "exited",
			exitCode: null,
			signal: null,
			requestedTerminationReason: reason,
		};
		state = next;
		emit({ type: "state", previous, event, next });
	};

	let removeExternalAbortListener: (() => void) | undefined;
	if (externalSignal) {
		const onAbort = () => {
			void cancel("abort");
		};
		if (externalSignal.aborted) onAbort();
		else externalSignal.addEventListener("abort", onAbort, { once: true });
		removeExternalAbortListener = () => externalSignal.removeEventListener("abort", onAbort);
	}

	const result = (async (): Promise<PiActorResult> => {
		let unsubscribeRuntime: (() => void) | undefined;
		try {
			const queuedReason = await Promise.race([
				waitForTurn.then(() => undefined as RunTerminationReason | undefined),
				queuedCancellation.then((reason) => reason),
			]);

			if (queuedReason) {
				moveToExited(queuedReason);
				return createCancelledResult(request, queuedReason);
			}

			runtimeHandle = runtime.invoke(request, { signal: externalSignal });
			const runtimeSnapshot = runtimeHandle.getSnapshot();
			state = runtimeSnapshot.state;
			pid = runtimeSnapshot.pid;
			startedAt = runtimeSnapshot.startedAt;

			unsubscribeRuntime = runtimeHandle.subscribe((event) => {
				if (event.type === "state") {
					state = event.next;
					if ("pid" in event.next && typeof event.next.pid === "number") {
						pid = event.next.pid;
					}
				}
				emit(event);
			});

			if (requestedTerminationReason) {
				await runtimeHandle.cancel(requestedTerminationReason);
			}

			const runtimeResult = await runtimeHandle.result;
			state = runtimeResult.finalState;
			if (typeof runtimeResult.finalState.pid === "number") {
				pid = runtimeResult.finalState.pid;
			}
			return runtimeResult;
		} catch (error) {
			const reason = requestedTerminationReason
				?? (externalSignal?.aborted || isAbortError(error) ? "abort" : "error");
			moveToExited(reason);
			return createCancelledResult(request, reason, toErrorMessage(error));
		} finally {
			unsubscribeRuntime?.();
			removeExternalAbortListener?.();
			releaseTurn();
			onSettled();
		}
	})();

	const cancel = async (reason: RunTerminationReason = "abort"): Promise<void> => {
		requestedTerminationReason ??= reason;
		if (runtimeHandle) {
			await runtimeHandle.cancel(requestedTerminationReason);
			return;
		}

		cancelQueuedWait?.(requestedTerminationReason);
		cancelQueuedWait = null;
	};

	const getSnapshot = (): PiActorSnapshot => {
		if (runtimeHandle) {
			const runtimeSnapshot = runtimeHandle.getSnapshot();
			state = runtimeSnapshot.state;
			pid = runtimeSnapshot.pid;
			startedAt = runtimeSnapshot.startedAt;
		}
		return {
			runId: request.runId,
			thread: request.thread,
			pid,
			startedAt,
			state,
		};
	};

	return {
		runId: request.runId,
		thread: request.thread,
		result,
		cancel,
		subscribe(listener: (event: PiActorEvent) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot,
	};
}

/**
 * Minimal supervisor: serialize per-thread invocations, keep different thread
 * names concurrent, and expose cancellation/inspection hooks.
 */
export class ThreadSupervisor {
	private readonly threadQueues = new Map<string, Promise<void>>();
	private readonly activeInvocations = new Map<string, ThreadHandle>();

	constructor(private readonly runtime: PiActorRuntime) {}

	invoke(request: PiActorInvocationRequest, options: ThreadInvokeOptions = {}): ThreadHandle {
		if (this.activeInvocations.has(request.runId)) {
			throw new Error(`Run '${request.runId}' is already active`);
		}

		const previous = this.threadQueues.get(request.thread) ?? Promise.resolve();
		const waitForTurn = previous.catch(() => undefined);

		let releaseTurn!: () => void;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const queueTail = waitForTurn.then(() => turnGate);
		this.threadQueues.set(request.thread, queueTail);

		const invocation = createSupervisedInvocation({
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
		return this.activeInvocations.get(runId)?.getSnapshot();
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
