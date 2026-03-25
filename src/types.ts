import type { Message } from "@mariozechner/pi-ai";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ThreadStats {
	contextTokens: number;
	lastCompactedAt: number;
	compactionCount: number;
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
	compaction?: { tokensBefore: number; tokensAfter: number };
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

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };
