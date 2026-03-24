import type { Message } from "@mariozechner/pi-ai";
import type { DispatchHistoryItem } from "../dispatch/history";

import {
	normalizeSessionPath,
	summarizeOutputPreview,
	summarizeOutputTail,
	summarizeRecentTool,
	summarizeToolCall,
	toSubagentStatus,
	type SubagentCard,
	type SubagentStatus,
} from "./metadata";

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

export interface StartRunInput {
	parentSessionFile: string;
	runId: string;
	thread: string;
	sessionPath: string;
	action: string;
}

export interface LiveMessageInput {
	parentSessionFile: string;
	runId: string;
	sessionPath: string;
	message: Message;
	liveCost: number;
}

export interface FinishRunInput {
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

function getResultKey(item: { action: string; episodeNumber: number; sessionPath: string }): string {
	return `${item.episodeNumber}:${item.action}:${item.sessionPath}`;
}

function applyMessageSummary(record: SubagentRunRecord, messages: readonly Message[]): void {
	record.outputTail = summarizeOutputTail(messages);
	record.outputPreview = summarizeOutputPreview(messages);
	record.toolPreview = summarizeRecentTool(messages);
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
		const existing = parentRecords.get(normalizedSessionPath) ?? createEmptyRecord(thread, normalizedSessionPath);
		const next: SubagentRunRecord = {
			...existing,
			thread,
			sessionPath: normalizedSessionPath,
			outputTail: [...existing.outputTail],
		};
		parentRecords.set(normalizedSessionPath, next);
		return next;
	}

	seedCompletedFromParent(parentSessionFile: string | undefined, parentDispatchItems: readonly DispatchHistoryItem[]): void {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return;

		const seenResultKeys = this.getOrCreateSeenResultKeys(normalizedParent);

		for (const item of parentDispatchItems) {
			const record = this.upsert(normalizedParent, item.thread, item.result.sessionPath);
			if (!record) continue;

			if (!record.activeRunId) {
				record.latestAction = item.action;
				record.status = toSubagentStatus(item.result);
				if (item.result.messages.length > 0) applyMessageSummary(record, item.result.messages);
			}

			const resultKey = getResultKey({
				action: item.action,
				episodeNumber: item.episodeNumber,
				sessionPath: item.result.sessionPath,
			});
			if (!seenResultKeys.has(resultKey)) {
				seenResultKeys.add(resultKey);
				record.persistedCost += item.result.usageCost;
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
		const record = this.getRecord(input.parentSessionFile, input.sessionPath);
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
		applyMessageSummary(record, input.messages);

		const normalizedSessionPath = normalizeSessionPath(input.sessionPath);
		if (!normalizedSessionPath) return;

		const resultKey = getResultKey({
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

	getCards(parentSessionFile: string | undefined): SubagentCard[] {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		if (!normalizedParent) return [];

		const records = this.recordsByParentSession.get(normalizedParent);
		if (!records) return [];

		return [...records.values()]
			.map((record) => toCard(record))
			.sort((left, right) => left.thread.localeCompare(right.thread));
	}

	private getRecord(parentSessionFile: string | undefined, sessionPath: string): SubagentRunRecord | undefined {
		const normalizedParent = normalizeSessionPath(parentSessionFile);
		const normalizedSessionPath = normalizeSessionPath(sessionPath);
		if (!normalizedParent || !normalizedSessionPath) return undefined;
		return this.recordsByParentSession.get(normalizedParent)?.get(normalizedSessionPath);
	}
}
