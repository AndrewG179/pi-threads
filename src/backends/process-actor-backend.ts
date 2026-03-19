import { spawn } from "node:child_process";

import { ProcessActor } from "../actors/process-actor";
import type { TerminateActorProcessResult } from "../actors/termination";
import type { ActorBackend } from "./actor-backend";
import { ActorAlreadyExistsError, ActorNotFoundError } from "./actor-backend";
import type { ActorId, ActorInstance, ActorSpawnRequest, ThreadName } from "../actors/types";

export interface ProcessActorBackendOptions {
	defaultSigtermGraceMs?: number;
}

export class ProcessActorBackend implements ActorBackend {
	private readonly actors = new Map<ActorId, ProcessActor>();
	private readonly actorsByThread = new Map<ThreadName, Set<ActorId>>();
	private readonly defaultSigtermGraceMs: number;

	constructor(options: ProcessActorBackendOptions = {}) {
		this.defaultSigtermGraceMs = options.defaultSigtermGraceMs ?? 5_000;
	}

	async spawnActor(request: ActorSpawnRequest): Promise<ActorInstance> {
		if (this.actors.has(request.actorId)) {
			throw new ActorAlreadyExistsError(request.actorId);
		}

		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env: request.env,
			stdio: request.stdio ?? "pipe",
			shell: false,
		});

		const actor = new ProcessActor({
			actorId: request.actorId,
			thread: request.thread,
			child,
			terminationPolicy: {
				sigtermGraceMs: request.termination?.sigtermGraceMs ?? this.defaultSigtermGraceMs,
			},
		});

		this.actors.set(request.actorId, actor);

		let threadSet = this.actorsByThread.get(request.thread);
		if (!threadSet) {
			threadSet = new Set<ActorId>();
			this.actorsByThread.set(request.thread, threadSet);
		}
		threadSet.add(request.actorId);

		return actor;
	}

	getActor(actorId: ActorId): ActorInstance | undefined {
		return this.actors.get(actorId);
	}

	listActors(): readonly ActorInstance[] {
		return [...this.actors.values()];
	}

	listActorsForThread(thread: ThreadName): readonly ActorInstance[] {
		const actorIds = this.actorsByThread.get(thread);
		if (!actorIds) return [];

		const actors: ActorInstance[] = [];
		for (const actorId of actorIds) {
			const actor = this.actors.get(actorId);
			if (actor) actors.push(actor);
		}
		return actors;
	}

	async terminateActor(actorId: ActorId, reason: string): Promise<TerminateActorProcessResult> {
		const actor = this.actors.get(actorId);
		if (!actor) {
			throw new ActorNotFoundError(actorId);
		}

		return actor.terminate(reason);
	}

	removeActor(actorId: ActorId): boolean {
		const actor = this.actors.get(actorId);
		if (!actor) return false;

		this.actors.delete(actorId);

		const threadSet = this.actorsByThread.get(actor.thread);
		if (threadSet) {
			threadSet.delete(actorId);
			if (threadSet.size === 0) {
				this.actorsByThread.delete(actor.thread);
			}
		}

		return true;
	}
}
