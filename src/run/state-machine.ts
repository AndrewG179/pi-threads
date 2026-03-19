export type RunTerminationReason =
	| "abort"
	| "timeout"
	| "shutdown"
	| "error"
	| "completed"
	| (string & {});

export interface QueuedRunState {
	tag: "queued";
}

export interface RunningRunState {
	tag: "running";
	pid: number;
}

export interface TerminatingRunState {
	tag: "terminating";
	pid: number;
	reason: RunTerminationReason;
}

export interface ExitedRunState {
	tag: "exited";
	pid?: number | null;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	requestedTerminationReason?: RunTerminationReason;
}

export type RunState = QueuedRunState | RunningRunState | TerminatingRunState | ExitedRunState;

export interface RunStartedEvent {
	type: "started";
	pid: number;
}

export interface RunTerminationRequestedEvent {
	type: "terminationRequested";
	reason: RunTerminationReason;
}

export interface RunExitedEvent {
	type: "exited";
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export type RunEvent = RunStartedEvent | RunTerminationRequestedEvent | RunExitedEvent;

export const INITIAL_RUN_STATE: QueuedRunState = { tag: "queued" };

export function transitionRunState(state: QueuedRunState, event: RunStartedEvent): RunningRunState;
export function transitionRunState(state: RunningRunState, event: RunTerminationRequestedEvent): TerminatingRunState;
export function transitionRunState(state: RunningRunState, event: RunExitedEvent): ExitedRunState;
export function transitionRunState(state: TerminatingRunState, event: RunExitedEvent): ExitedRunState;
export function transitionRunState(state: RunState, event: RunEvent): RunState {
	switch (state.tag) {
		case "queued":
			return event.type === "started" ? { tag: "running", pid: event.pid } : state;
		case "running":
			if (event.type === "terminationRequested") {
				return { tag: "terminating", pid: state.pid, reason: event.reason };
			}
			if (event.type === "exited") {
				return {
					tag: "exited",
					pid: state.pid,
					exitCode: event.exitCode,
					signal: event.signal,
				};
			}
			return state;
		case "terminating":
			return event.type === "exited"
				? {
						tag: "exited",
						pid: state.pid,
						exitCode: event.exitCode,
						signal: event.signal,
						requestedTerminationReason: state.reason,
					}
				: state;
		case "exited":
			return state;
	}
}
