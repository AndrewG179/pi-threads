import type { Message } from "@mariozechner/pi-ai";

import { type SingleDispatchResult, type ThreadActionResult, resolveDispatchSessionPath } from "./contract";

export type DispatchHistoryItem = Pick<SingleDispatchResult, "thread" | "action" | "episodeNumber"> & {
	result: Pick<ThreadActionResult, "sessionPath" | "messages"> & {
		exitCode?: number;
		stopReason?: string;
		usageCost: number;
	};
};

type PersistedDispatchItem = Partial<Pick<SingleDispatchResult, "thread" | "action" | "episodeNumber">> & {
	result?: Partial<Pick<ThreadActionResult, "sessionPath" | "exitCode" | "stopReason">> & {
		messages?: Message[];
		usage?: {
			cost?: unknown;
		};
	};
};

interface SessionEntry {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
}

function extractUsageCost(cost: unknown): number {
	if (typeof cost === "number" && Number.isFinite(cost)) return cost;
	if (typeof cost === "object" && cost !== null) {
		const total = (cost as { total?: unknown }).total;
		return typeof total === "number" && Number.isFinite(total) ? total : 0;
	}
	return 0;
}

export function collectCompletedDispatchItems(cwd: string, parentBranchEntries: readonly unknown[]): DispatchHistoryItem[] {
	const items: DispatchHistoryItem[] = [];

	for (const entry of parentBranchEntries) {
		if (typeof entry !== "object" || entry === null) continue;
		const line = entry as SessionEntry;
		if (line.type !== "message" || line.message?.role !== "toolResult" || line.message.toolName !== "dispatch") continue;

		const details = line.message.details as { items?: PersistedDispatchItem[] } | undefined;
		if (!details?.items) continue;

		for (const item of details.items) {
			if (!item.thread || !item.action || typeof item.episodeNumber !== "number") continue;

			items.push({
				thread: item.thread,
				action: item.action,
				episodeNumber: item.episodeNumber,
				result: {
					sessionPath: resolveDispatchSessionPath(cwd, item.thread, item.result?.sessionPath),
					exitCode: item.result?.exitCode,
					stopReason: item.result?.stopReason,
					messages: Array.isArray(item.result?.messages) ? item.result.messages : [],
					usageCost: extractUsageCost(item.result?.usage?.cost),
				},
			});
		}
	}

	return items;
}

export function rebuildEpisodeCounts(episodeCounts: Map<string, number>, items: readonly DispatchHistoryItem[]): void {
	episodeCounts.clear();
	for (const item of items) {
		episodeCounts.set(item.result.sessionPath, Math.max(episodeCounts.get(item.result.sessionPath) ?? 0, item.episodeNumber));
	}
}
