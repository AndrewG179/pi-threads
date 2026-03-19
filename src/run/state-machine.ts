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

export type StartedRunEvent = RunStartedEvent;
export type TerminationRequestedRunEvent = RunTerminationRequestedEvent;
export type ExitedRunEvent = RunExitedEvent;

export type RunEventByStateTag = {
	queued: RunStartedEvent;
	running: RunTerminationRequestedEvent | RunExitedEvent;
	terminating: RunExitedEvent;
	exited: never;
};

export type RunEventForState<TState extends RunState> = RunEventByStateTag[TState["tag"]];

export type NextRunState<
	TState extends RunState,
	TEvent extends RunEventForState<TState>,
> = TState extends QueuedRunState
	? TEvent extends RunStartedEvent
		? RunningRunState
		: never
	: TState extends RunningRunState
		? TEvent extends RunTerminationRequestedEvent
			? TerminatingRunState
			: TEvent extends RunExitedEvent
				? ExitedRunState
				: never
		: TState extends TerminatingRunState
			? TEvent extends RunExitedEvent
				? ExitedRunState
				: never
			: never;

export const INITIAL_RUN_STATE: QueuedRunState = { tag: "queued" };

export function isTerminalRunState(state: RunState): state is ExitedRunState {
	return state.tag === "exited";
}

export function canTransition<TState extends RunState>(
	state: TState,
	event: RunEvent,
): event is RunEventForState<TState> {
	switch (state.tag) {
		case "queued":
			return event.type === "started";
		case "running":
			return event.type === "terminationRequested" || event.type === "exited";
		case "terminating":
			return event.type === "exited";
		case "exited":
			return false;
	}
}

function invalidTransition<TState extends RunState>(state: TState, _event: RunEvent): TState {
	return state;
}

export function transitionRunState<
	TState extends RunState,
	TEvent extends RunEventForState<TState>,
>(state: TState, event: TEvent): NextRunState<TState, TEvent>;
export function transitionRunState(state: RunState, event: RunEvent): RunState {
	switch (state.tag) {
		case "queued": {
			if (event.type !== "started") return invalidTransition(state, event);
			return {
				tag: "running",
				pid: event.pid,
			};
		}
		case "running": {
			if (event.type === "terminationRequested") {
				return {
					tag: "terminating",
					pid: state.pid,
					reason: event.reason,
				};
			}
			if (event.type === "exited") {
				return {
					tag: "exited",
					pid: state.pid,
					exitCode: event.exitCode,
					signal: event.signal,
				};
			}
			return invalidTransition(state, event);
		}
		case "terminating": {
			if (event.type !== "exited") return invalidTransition(state, event);
			return {
				tag: "exited",
				pid: state.pid,
				exitCode: event.exitCode,
				signal: event.signal,
				requestedTerminationReason: state.reason,
			};
		}
		case "exited":
			return invalidTransition(state, event);
	}
}
