import type { EpisodeMessage } from "../episode/builder.js";
import type { ExitedRunState, RunEvent, RunState } from "../run/state-machine.js";

export interface RunUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export const EMPTY_RUN_USAGE_STATS: RunUsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

export interface RunBackendRequest {
	/**
	 * Stable identifier for this run instance.
	 * The caller owns this ID and can use it for correlation/logging.
	 */
	runId: string;

	/**
	 * Current working directory to execute from.
	 */
	cwd: string;

	/**
	 * Action/instruction payload the backend should execute.
	 */
	action: string;

	/**
	 * Optional logical session key for backend-specific context reuse.
	 */
	sessionKey?: string;

	/**
	 * Optional model identifier, if the backend is model-driven.
	 */
	model?: string;

	/**
	 * Optional system-level instruction block applied by the backend.
	 */
	systemPrompt?: string;

	/**
	 * Opaque extension point for backend-specific metadata.
	 */
	metadata?: Readonly<Record<string, unknown>>;
}

export interface RunBackendStateChange {
	previous: RunState;
	event: RunEvent;
	next: RunState;
}

export interface RunBackendObserver<TMessage extends EpisodeMessage = EpisodeMessage> {
	onStateChange?(change: RunBackendStateChange): void;
	onMessage?(message: TMessage): void;
	onStderr?(chunk: string): void;
}

export interface RunBackendRunOptions<TMessage extends EpisodeMessage = EpisodeMessage> {
	signal?: AbortSignal;
	observer?: RunBackendObserver<TMessage>;
}

export interface RunBackendResult<TMessage extends EpisodeMessage = EpisodeMessage> {
	runId: string;
	finalState: ExitedRunState;
	messages: readonly TMessage[];
	stderr: string;
	usage: RunUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface RunBackend<TMessage extends EpisodeMessage = EpisodeMessage> {
	readonly name: string;

	run(
		request: RunBackendRequest,
		options?: RunBackendRunOptions<TMessage>,
	): Promise<RunBackendResult<TMessage>>;
}

export interface TerminableRunBackend<TMessage extends EpisodeMessage = EpisodeMessage>
	extends RunBackend<TMessage> {
	terminate(runId: string): Promise<void>;
}
