import type { ActorBackend } from "../backends/actor-backend";
import type { RunTerminationReason } from "../run/state-machine";

import type { TerminateActorProcessResult } from "./termination";
import type { ActorId, ActorInstance, ActorSpawnRequest, ThreadName } from "./types";

export interface ThreadTerminationItem {
	actorId: ActorId;
	result: TerminateActorProcessResult;
}

function createAbortError(): Error {
	const error = new Error("Run was aborted while waiting for thread turn");
	error.name = "AbortError";
	return error;
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

/**
 * Coordinates actors by thread so each thread can be supervised independently.
 */
export class ThreadActorSupervisor {
	private readonly threadQueues = new Map<ThreadName, Promise<void>>();

	constructor(private readonly backend: ActorBackend) {}

	startActor(request: ActorSpawnRequest): Promise<ActorInstance> {
		return this.backend.spawnActor(request);
	}

	listThreadActors(thread: ThreadName): readonly ActorInstance[] {
		return this.backend.listActorsForThread(thread);
	}

	async terminateThread(thread: ThreadName, reason: RunTerminationReason): Promise<ThreadTerminationItem[]> {
		const actors = this.backend.listActorsForThread(thread);
		const terminationResults = await Promise.all(
			actors.map(async (actor) => ({
				actorId: actor.actorId,
				result: await this.backend.terminateActor(actor.actorId, reason),
			})),
		);

		return terminationResults;
	}

	terminateActor(actorId: ActorId, reason: RunTerminationReason): Promise<TerminateActorProcessResult> {
		return this.backend.terminateActor(actorId, reason);
	}

	removeActor(actorId: ActorId): boolean {
		return this.backend.removeActor(actorId);
	}

	/**
	 * Serialize operations per thread. Operations for different thread names
	 * remain fully concurrent.
	 */
	async runSerialized<T>(
		thread: ThreadName,
		operation: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const previous = this.threadQueues.get(thread) ?? Promise.resolve();
		const waitForTurn = previous.catch(() => undefined);

		let releaseTurn!: () => void;
		const currentTurn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});

		const queueTail = waitForTurn.then(() => currentTurn);
		this.threadQueues.set(thread, queueTail);

		try {
			await waitForPromiseWithSignal(waitForTurn, signal);
			if (signal?.aborted) throw createAbortError();
			return await operation();
		} finally {
			releaseTurn();
			if (this.threadQueues.get(thread) === queueTail) {
				this.threadQueues.delete(thread);
			}
		}
	}
}
