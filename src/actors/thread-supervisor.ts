import type { ActorBackend } from "../backends/actor-backend";

import type { TerminateActorProcessResult } from "./termination";
import type { ActorId, ActorInstance, ActorSpawnRequest, ThreadName } from "./types";

export interface ThreadTerminationItem {
	actorId: ActorId;
	result: TerminateActorProcessResult;
}

/**
 * Coordinates actors by thread so each thread can be supervised independently.
 *
 * This is intentionally self-contained and not wired into `index.ts` yet.
 */
export class ThreadActorSupervisor {
	constructor(private readonly backend: ActorBackend) {}

	startActor(request: ActorSpawnRequest): Promise<ActorInstance> {
		return this.backend.spawnActor(request);
	}

	listThreadActors(thread: ThreadName): readonly ActorInstance[] {
		return this.backend.listActorsForThread(thread);
	}

	async terminateThread(thread: ThreadName, reason: string): Promise<ThreadTerminationItem[]> {
		const actors = this.backend.listActorsForThread(thread);
		const terminationResults = await Promise.all(
			actors.map(async (actor) => ({
				actorId: actor.actorId,
				result: await this.backend.terminateActor(actor.actorId, reason),
			})),
		);

		return terminationResults;
	}

	removeActor(actorId: ActorId): boolean {
		return this.backend.removeActor(actorId);
	}
}
