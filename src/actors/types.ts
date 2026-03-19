import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { RunState } from "../run/state-machine";
import type { TerminateActorProcessOptions, TerminateActorProcessResult } from "./termination";

export type ActorId = string;
export type ThreadName = string;

export interface ActorTerminationPolicy extends TerminateActorProcessOptions {}

export interface ActorSpawnRequest {
	actorId: ActorId;
	thread: ThreadName;
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stdio?: SpawnOptions["stdio"];
	termination?: Partial<ActorTerminationPolicy>;
}

export interface ActorSnapshot {
	actorId: ActorId;
	thread: ThreadName;
	pid: number | undefined;
	state: RunState;
	startedAt: number;
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
}

export interface ActorInstance {
	readonly actorId: ActorId;
	readonly thread: ThreadName;
	readonly child: ChildProcess;
	readonly startedAt: number;
	readonly terminationPolicy: ActorTerminationPolicy;
	getSnapshot(): ActorSnapshot;
	waitForExit(): Promise<ActorSnapshot>;
	terminate(reason: string, options?: Partial<ActorTerminationPolicy>): Promise<TerminateActorProcessResult>;
}
