import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

import {
	getThreadSessionPath,
	summarizeOutputPreview,
	summarizeOutputTail,
	summarizeRecentTool,
	summarizeToolCall,
	type SubagentCard,
	type SubagentStatus,
} from "./metadata";

interface DispatchItem {
	thread?: string;
	action?: string;
	episodeNumber?: number;
	result?: {
		sessionPath?: string;
		exitCode?: number;
		stopReason?: string;
		messages?: Message[];
		usage?: {
			cost?: number | { total?: number };
		};
	};
}

interface SessionEntry {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
}

interface SubagentRunRecord {
	thread: string;
	sessionPath: string;
	latestAction: string;
	outputPreview: string;
	outputTail: string[];
	toolPreview: string;
	persistedCost: number;
	liveCost: number;
	status: SubagentStatus;
	activeRunId?: string;
}

interface StartRunInput {
	parentSessionFile: string;
	runId: string;
	thread: string;
	sessionPath: string;
	action: string;
}

interface LiveMessageInput {
	parentSessionFile: string;
	runId: string;
	thread: string;
	message: Message;
	liveCost: number;
}

interface FinishRunInput {
	parentSessionFile: string;
	runId: string;
	thread: string;
	sessionPath: string;
	action: string;
	episodeNumber: number;
	status: SubagentStatus;
	usageCost: number;
	messages: readonly Message[];
}

function normalizeSessionPath(sessionPath: string | undefined): string | undefined {
	return sessionPath ? path.resolve(sessionPath) : undefined;
}

function extractUsageCost(cost: unknown): number {
	if (typeof cost === "number" && Number.isFinite(cost)) return cost;
	if (typeof cost === "object" && cost !== null) {
		const total = (cost as { total?: unknown }).total;
		return typeof total === "number" && Number.isFinite(total) ? total : 0;
	}
	return 0;
}

function getDispatchStatus(result: DispatchItem["result"]): SubagentStatus {
	if (!result) return "unknown";
	if (result.stopReason === "escalated") return "escalated";
	if (result.stopReason === "aborted" || result.stopReason === "error" || (typeof result.exitCode === "number" && result.exitCode !== 0)) {
		return "aborted";
	}
	return result.exitCode === 0 ? "done" : "unknown";
}

function createEmptyRecord(thread: string, sessionPath: string): SubagentRunRecord {
	return {
		thread,
		sessionPath,
		latestAction: "",
		outputPreview: "",
		outputTail: [],
		toolPreview: "",
		persistedCost: 0,
		liveCost: 0,
		status: "unknown",
	};
}

function toCard(record: SubagentRunRecord): SubagentCard {
	return {
		thread: record.thread,
		sessionPath: record.sessionPath,
		latestAction: record.latestAction,
		outputPreview: record.outputPreview,
		outputTail: [...record.outputTail],
		toolPreview: record.toolPreview,
		accumulatedCost: record.persistedCost + record.liveCost,
		status: record.status,
	};
}

function getResultKey(item: { thread: string; action: string; episodeNumber: number; sessionPath: string }): string {
	return `${item.thread}:${item.episodeNumber}:${item.action}:${item.sessionPath}`;
}

export class SubagentRunStore {
	private readonly recordsByParentSession = new Map<string, Map<string, SubagentRunRecord>>();
	private readonly seenResultKeysByParentSession = new Map<string, Set<string>>();

	private getOrCreateParentRecords(parentSessionFile: string): Map<string, SubagentRunRecord> {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return new Map<string, SubagentRunRecord>();

		const existing = this.recordsByParentSession.get(normalizedParent);
		if (existing) return existing;

		const created = new Map<string, SubagentRunRecord>();
		this.recordsByParentSession.set(normalizedParent, created);
		return created;
	}

	private getOrCreateSeenResultKeys(parentSessionFile: string): Set<string> {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return new Set<string>();

		const existing = this.seenResultKeysByParentSession.get(normalizedParent);
		if (existing) return existing;

		const created = new Set<string>();
		this.seenResultKeysByParentSession.set(normalizedParent, created);
		return created;
	}

	private upsert(parentSessionFile: string, thread: string, sessionPath: string): SubagentRunRecord | undefined {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		const normalizedSessionPath = normalizeSessionPath(sessionPath);
		if (!normalizedParent || !normalizedSessionPath) return undefined;

		const parentRecords = this.getOrCreateParentRecords(normalizedParent);
		const existing = parentRecords.get(thread) ?? createEmptyRecord(thread, normalizedSessionPath);
		const next: SubagentRunRecord = {
			...existing,
			thread,
			sessionPath: normalizedSessionPath,
			outputTail: [...existing.outputTail],
		};
		parentRecords.set(thread, next);
		return next;
	}

	seedCompletedFromParent(parentSessionFile: string | undefined, cwd: string, parentBranchEntries: readonly unknown[]): void {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return;

		const threadsDir = path.join(cwd, ".pi", "threads");
		const seenResultKeys = this.getOrCreateSeenResultKeys(normalizedParent);

		for (const entry of parentBranchEntries) {
			if (typeof entry !== "object" || entry === null) continue;
			const line = entry as SessionEntry;
			if (line.type !== "message" || line.message?.role !== "toolResult" || line.message.toolName !== "dispatch") continue;

			const details = line.message.details as { items?: DispatchItem[] } | undefined;
			if (!details?.items) continue;

			for (const item of details.items) {
				if (!item.thread || !item.action || typeof item.episodeNumber !== "number") continue;

				const sessionPath = normalizeSessionPath(item.result?.sessionPath) ?? getThreadSessionPath(threadsDir, item.thread);
				const record = this.upsert(normalizedParent, item.thread, sessionPath);
				if (!record) continue;

				record.latestAction = item.action;
				record.status = getDispatchStatus(item.result);

				const messages = Array.isArray(item.result?.messages) ? item.result.messages : [];
				if (messages.length > 0) {
					record.outputTail = summarizeOutputTail(messages);
					record.outputPreview = summarizeOutputPreview(messages);
					record.toolPreview = summarizeRecentTool(messages);
				}

				const resultKey = getResultKey({
					thread: item.thread,
					action: item.action,
					episodeNumber: item.episodeNumber,
					sessionPath,
				});
				if (!seenResultKeys.has(resultKey)) {
					seenResultKeys.add(resultKey);
					record.persistedCost += extractUsageCost(item.result?.usage?.cost);
				}
			}
		}
	}

	startRun(input: StartRunInput): void {
		const record = this.upsert(input.parentSessionFile, input.thread, input.sessionPath);
		if (!record) return;

		record.latestAction = input.action;
		record.outputPreview = "";
		record.outputTail = [];
		record.toolPreview = "";
		record.liveCost = 0;
		record.status = "unknown";
		record.activeRunId = input.runId;
	}

	recordMessage(input: LiveMessageInput): void {
		const record = this.getRecord(input.parentSessionFile, input.thread);
		if (!record || record.activeRunId !== input.runId) return;

		const messageOutput = summarizeOutputTail([input.message]);
		if (messageOutput.length > 0) {
			record.outputTail = [...record.outputTail, ...messageOutput].slice(-8);
			record.outputPreview = record.outputTail.at(-1) ?? record.outputPreview;
		}

		const toolPreview = summarizeToolCall(input.message.content);
		if (toolPreview) {
			record.toolPreview = toolPreview;
		}

		record.liveCost = input.liveCost;
	}

	finishRun(input: FinishRunInput): void {
		const record = this.upsert(input.parentSessionFile, input.thread, input.sessionPath);
		if (!record) return;
		if (record.activeRunId && record.activeRunId !== input.runId) return;

		record.latestAction = input.action;
		record.status = input.status;
		record.liveCost = 0;
		record.activeRunId = undefined;
		record.outputTail = summarizeOutputTail(input.messages);
		record.outputPreview = summarizeOutputPreview(input.messages);
		record.toolPreview = summarizeRecentTool(input.messages);

		const normalizedSessionPath = normalizeSessionPath(input.sessionPath);
		if (!normalizedSessionPath) return;

		const resultKey = getResultKey({
			thread: input.thread,
			action: input.action,
			episodeNumber: input.episodeNumber,
			sessionPath: normalizedSessionPath,
		});
		const seenResultKeys = this.getOrCreateSeenResultKeys(input.parentSessionFile);
		if (!seenResultKeys.has(resultKey)) {
			seenResultKeys.add(resultKey);
			record.persistedCost += input.usageCost;
		}
	}

	getCard(parentSessionFile: string | undefined, thread: string): SubagentCard | undefined {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return undefined;
		const record = this.recordsByParentSession.get(normalizedParent)?.get(thread);
		return record ? toCard(record) : undefined;
	}

	getCards(parentSessionFile: string | undefined): SubagentCard[] {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return [];

		const records = this.recordsByParentSession.get(normalizedParent);
		if (!records) return [];

		return [...records.values()]
			.map((record) => toCard(record))
			.sort((left, right) => left.thread.localeCompare(right.thread));
	}

	private getRecord(parentSessionFile: string | undefined, thread: string): SubagentRunRecord | undefined {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return undefined;
		return this.recordsByParentSession.get(normalizedParent)?.get(thread);
	}
}
