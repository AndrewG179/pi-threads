import { EventEmitter } from "node:events";

import type { ThreadStats } from "./types.ts";
import { listThreads as listThreadsFromDir } from "./helpers.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export class ThreadRegistry {
	private _episodeCounts = new Map<string, number>();
	private _threadStats = new Map<string, ThreadStats>();
	private _runningThreads = new Set<string>();
	private _lastActivity = new Map<string, number>();
	private _threadErrors = new Map<string, boolean>();
	private emitter = new EventEmitter();

	subagentModel = "anthropic/claude-sonnet-4-6";
	subagentThinking: ThinkingLevel | undefined = undefined;

	/** Set thinking level with validation. Invalid values are silently ignored. */
	setThinking(value: string | undefined): void {
		if (value === undefined) {
			this.subagentThinking = undefined;
		} else if ((THINKING_LEVELS as readonly string[]).includes(value)) {
			this.subagentThinking = value as ThinkingLevel;
		}
	}

	// ─── Read-only accessors ───

	get episodeCounts(): ReadonlyMap<string, number> {
		return this._episodeCounts;
	}

	get threadStats(): ReadonlyMap<string, ThreadStats> {
		return this._threadStats;
	}

	get runningThreads(): ReadonlySet<string> {
		return this._runningThreads;
	}

	get lastActivity(): ReadonlyMap<string, number> {
		return this._lastActivity;
	}

	get threadErrors(): ReadonlyMap<string, boolean> {
		return this._threadErrors;
	}

	// ─── Queries ───

	listThreads(cwd: string): string[] {
		return listThreadsFromDir(cwd);
	}

	getThreadState(name: string): { episodes: number; stats: ThreadStats | undefined } {
		return {
			episodes: this._episodeCounts.get(name) || 0,
			stats: this._threadStats.get(name),
		};
	}

	// ─── Mutations (all emit automatically) ───

	setEpisodeCount(name: string, count: number): void {
		this._episodeCounts.set(name, count);
		this.emit();
	}

	updateEpisodeCount(name: string, count: number): void {
		this._episodeCounts.set(name, Math.max(this._episodeCounts.get(name) || 0, count));
		this.emit();
	}

	updateThreadStats(name: string, stats: ThreadStats): void {
		this._threadStats.set(name, stats);
		this.emit();
	}

	markRunning(name: string): void {
		this._runningThreads.add(name);
		this.emit();
	}

	markDone(name: string): void {
		this._runningThreads.delete(name);
		this._lastActivity.set(name, Date.now());
		this.emit();
	}

	markError(name: string): void {
		this._threadErrors.set(name, true);
		this.emit();
	}

	clearError(name: string): void {
		this._threadErrors.delete(name);
		this.emit();
	}

	// ─── Listener management ───

	onChange(cb: () => void): () => void {
		this.emitter.on("change", cb);
		return () => { this.emitter.off("change", cb); };
	}

	// ─── Bulk operations ───

	clear(): void {
		this._episodeCounts.clear();
		this._threadStats.clear();
		this._lastActivity.clear();
		this._threadErrors.clear();
		this._runningThreads.clear();
		this.emit();
	}

	deleteThread(name: string): void {
		this._episodeCounts.delete(name);
		this._threadStats.delete(name);
		this._lastActivity.delete(name);
		this._threadErrors.delete(name);
		this._runningThreads.delete(name);
		this.emit();
	}

	resetThread(name: string): void {
		this._threadStats.delete(name);
		this._lastActivity.set(name, Date.now());
		this._threadErrors.delete(name);
		this._runningThreads.delete(name);
		// Preserve episodeCounts — thread identity is kept
		this.emit();
	}

	private emit(): void {
		this.emitter.emit("change");
	}
}
