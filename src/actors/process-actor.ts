import type { ChildProcess } from "node:child_process";

import { transitionRunState, type ExitedRunEvent, type RunState } from "../run/state-machine";
import { terminateActorProcess, type TerminateActorProcessResult } from "./termination";
import type { ActorInstance, ActorSnapshot, ActorTerminationPolicy } from "./types";

export interface ProcessActorParams {
	actorId: string;
	thread: string;
	child: ChildProcess;
	startedAt?: number;
	terminationPolicy: ActorTerminationPolicy;
}

export class ProcessActor implements ActorInstance {
	readonly actorId: string;
	readonly thread: string;
	readonly child: ChildProcess;
	readonly startedAt: number;
	readonly terminationPolicy: ActorTerminationPolicy;

	private state: RunState;
	private exitCode: number | null = null;
	private exitSignal: NodeJS.Signals | null = null;
	private readonly exitPromise: Promise<ActorSnapshot>;
	private resolveExitPromise!: (snapshot: ActorSnapshot) => void;
	private exitResolved = false;

	constructor(params: ProcessActorParams) {
		this.actorId = params.actorId;
		this.thread = params.thread;
		this.child = params.child;
		this.startedAt = params.startedAt ?? Date.now();
		this.terminationPolicy = params.terminationPolicy;

		if (typeof this.child.pid === "number") {
			this.state = transitionRunState({ tag: "queued" }, { type: "started", pid: this.child.pid });
		} else {
			this.state = { tag: "queued" };
		}

		this.exitPromise = new Promise<ActorSnapshot>((resolve) => {
			this.resolveExitPromise = resolve;
		});

		const alreadyExited = this.getCurrentExit();
		if (alreadyExited) {
			this.recordExit(alreadyExited.exitCode, alreadyExited.exitSignal);
		} else {
			this.child.once("exit", (exitCode, exitSignal) => {
				this.recordExit(exitCode, exitSignal);
			});
		}
	}

	getSnapshot(): ActorSnapshot {
		return {
			actorId: this.actorId,
			thread: this.thread,
			pid: this.child.pid ?? undefined,
			state: this.state,
			startedAt: this.startedAt,
			exitCode: this.exitCode,
			exitSignal: this.exitSignal,
		};
	}

	async waitForExit(): Promise<ActorSnapshot> {
		if (this.state.tag === "exited") {
			return this.getSnapshot();
		}

		return this.exitPromise;
	}

	async terminate(reason: string, options?: Partial<ActorTerminationPolicy>): Promise<TerminateActorProcessResult> {
		if (this.state.tag === "queued" && typeof this.child.pid === "number") {
			this.state = transitionRunState(this.state, { type: "started", pid: this.child.pid });
		}

		if (this.state.tag === "running") {
			this.state = transitionRunState(this.state, { type: "terminationRequested", reason });
		}

		const sigtermGraceMs = options?.sigtermGraceMs ?? this.terminationPolicy.sigtermGraceMs;
		const result = await terminateActorProcess(this.child, { sigtermGraceMs });

		await this.waitForExit();
		return result;
	}

	private getCurrentExit(): { exitCode: number | null; exitSignal: NodeJS.Signals | null } | null {
		if (this.child.exitCode === null && this.child.signalCode === null) return null;
		return {
			exitCode: this.child.exitCode,
			exitSignal: this.child.signalCode,
		};
	}

	private recordExit(exitCode: number | null, exitSignal: NodeJS.Signals | null): void {
		if (this.exitResolved) return;

		this.exitCode = exitCode;
		this.exitSignal = exitSignal;

		const exitedEvent: ExitedRunEvent = { type: "exited", exitCode, signal: exitSignal };

		switch (this.state.tag) {
			case "running":
				this.state = transitionRunState(this.state, exitedEvent);
				break;
			case "terminating":
				this.state = transitionRunState(this.state, exitedEvent);
				break;
			case "queued":
			case "exited":
				this.state = { tag: "exited", exitCode, signal: exitSignal };
				break;
		}

		this.exitResolved = true;
		this.resolveExitPromise(this.getSnapshot());
	}
}
