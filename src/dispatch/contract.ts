import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

import { getThreadSessionPath, normalizeSessionPath } from "../subagents/metadata";

const THREADS_DIR = ".pi/threads";

export interface DispatchTask {
	thread: string;
	action: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ThreadActionResult {
	thread: string;
	action: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sessionPath: string;
	isNewThread: boolean;
}

export interface SingleDispatchResult {
	thread: string;
	action: string;
	episode: string;
	episodeNumber: number;
	result: ThreadActionResult;
}

export interface DispatchDetails {
	mode: "single" | "batch";
	items: SingleDispatchResult[];
}

export function getThreadsDir(cwd: string): string {
	return path.join(cwd, THREADS_DIR);
}

export function resolveDispatchSessionPath(cwd: string, thread: string, sessionPath?: string): string {
	return normalizeSessionPath(sessionPath) ?? getThreadSessionPath(getThreadsDir(cwd), thread);
}

export function createEmptyUsageStats(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function createEmptyThreadActionResult(params: {
	thread: string;
	action: string;
	model: string | undefined;
	sessionPath: string;
	isNewThread: boolean;
}): ThreadActionResult {
	return {
		thread: params.thread,
		action: params.action,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: createEmptyUsageStats(),
		model: params.model,
		sessionPath: params.sessionPath,
		isNewThread: params.isNewThread,
	};
}

export function getDispatchFailureSummary(result: Pick<ThreadActionResult, "errorMessage" | "stderr">): string | undefined {
	const errorText = result.errorMessage?.trim() || result.stderr.trim();
	return errorText ? `THREAD ERROR:\n${errorText}` : undefined;
}

export function findDuplicateThreads(tasks: readonly Pick<DispatchTask, "thread">[], threadsDir: string): string[] {
	const threadsBySessionPath = new Map<string, string[]>();
	for (const task of tasks) {
		const sessionPath = getThreadSessionPath(threadsDir, task.thread);
		const threads = threadsBySessionPath.get(sessionPath);
		if (threads) {
			threads.push(task.thread);
		} else {
			threadsBySessionPath.set(sessionPath, [task.thread]);
		}
	}
	return [...new Set(
		[...threadsBySessionPath.values()]
			.filter((threads) => threads.length > 1)
			.flat(),
	)];
}
