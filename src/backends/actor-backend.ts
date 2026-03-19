import type { TerminateActorProcessResult } from "../actors/termination";
import type { ActorId, ActorInstance, ActorSpawnRequest, ThreadName } from "../actors/types";

export interface ActorBackend {
	spawnActor(request: ActorSpawnRequest): Promise<ActorInstance>;
	getActor(actorId: ActorId): ActorInstance | undefined;
	listActors(): readonly ActorInstance[];
	listActorsForThread(thread: ThreadName): readonly ActorInstance[];
	terminateActor(actorId: ActorId, reason: string): Promise<TerminateActorProcessResult>;
	removeActor(actorId: ActorId): boolean;
}

export class ActorAlreadyExistsError extends Error {
	constructor(actorId: ActorId) {
		super(`Actor '${actorId}' already exists`);
		this.name = "ActorAlreadyExistsError";
	}
}

export class ActorNotFoundError extends Error {
	constructor(actorId: ActorId) {
		super(`Actor '${actorId}' was not found`);
		this.name = "ActorNotFoundError";
	}
}
