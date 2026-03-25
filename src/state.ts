import { EventEmitter } from "node:events";

import type { ThreadStats } from "./types.ts";
import { listThreads as listThreadsFromDir } from "./helpers.ts";

export class ThreadRegistry {
	episodeCounts = new Map<string, number>();
	threadStats = new Map<string, ThreadStats>();
	subagentModel = "anthropic/claude-sonnet-4-6";
	subagentThinking: string | undefined = undefined;
	runningThreads = new Set<string>();
	lastActivity = new Map<string, number>();
	threadErrors = new Map<string, boolean>();

	private emitter = new EventEmitter();

	listThreads(cwd: string): string[] {
		return listThreadsFromDir(cwd);
	}

	getThreadState(name: string): { episodes: number; stats: ThreadStats | undefined } {
		return {
			episodes: this.episodeCounts.get(name) || 0,
			stats: this.threadStats.get(name),
		};
	}

	markRunning(name: string): void {
		this.runningThreads.add(name);
		this.emit();
	}

	markDone(name: string): void {
		this.runningThreads.delete(name);
		this.lastActivity.set(name, Date.now());
		this.emit();
	}

	markError(name: string): void {
		this.threadErrors.set(name, true);
		this.emit();
	}

	clearError(name: string): void {
		this.threadErrors.delete(name);
		this.emit();
	}

	onChange(cb: () => void): void {
		this.emitter.on("change", cb);
	}

	emit(): void {
		this.emitter.emit("change");
	}

	clear(): void {
		this.episodeCounts.clear();
		this.threadStats.clear();
		this.lastActivity.clear();
		this.threadErrors.clear();
		this.emit();
	}

	clearThread(name: string): void {
		this.episodeCounts.delete(name);
		this.threadStats.delete(name);
		this.lastActivity.delete(name);
		this.threadErrors.delete(name);
		this.emit();
	}
}
