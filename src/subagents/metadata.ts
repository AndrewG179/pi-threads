import * as fs from "node:fs";
import * as path from "node:path";

import { loadThreadsState } from "./state";

export type SubagentStatus = "done" | "escalated" | "aborted" | "unknown";

export interface SubagentCard {
	thread: string;
	sessionPath: string;
	latestAction: string;
	outputPreview: string;
	toolPreview: string;
	accumulatedCost: number;
	status: SubagentStatus;
	parentSessionFile?: string;
}

interface SessionMessageContentPart {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface SessionMessage {
	role?: string;
	content?: SessionMessageContentPart[];
	toolName?: string;
	details?: unknown;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
}

interface SessionLine {
	type?: string;
	message?: SessionMessage;
}

interface DispatchItem {
	thread?: string;
	action?: string;
	episode?: string;
	result?: {
		exitCode?: number;
		stopReason?: string;
		errorMessage?: string;
		usage?: {
			cost?: number | { total?: number };
		};
	};
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
	const normalized = normalizeText(text);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function extractText(parts: SessionMessageContentPart[] | undefined): string {
	if (!parts || parts.length === 0) return "";
	return normalizeText(
		parts
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text!)
			.join("\n"),
	);
}

function summarizeToolCall(parts: SessionMessageContentPart[] | undefined): string {
	if (!parts || parts.length === 0) return "";
	const toolCall = [...parts].reverse().find((part) => part.type === "toolCall" && typeof part.name === "string");
	if (!toolCall) return "";

	switch (toolCall.name) {
		case "bash": {
			const command = typeof toolCall.arguments?.command === "string" ? toolCall.arguments.command : "";
			return truncate(`$ ${command || "(no command)"}`, 120);
		}
		case "read":
		case "write":
		case "edit": {
			const filePath =
				typeof toolCall.arguments?.path === "string"
					? toolCall.arguments.path
					: typeof toolCall.arguments?.file_path === "string"
						? toolCall.arguments.file_path
						: "";
			return truncate(`${toolCall.name} ${filePath || "(no path)"}`, 120);
		}
		default:
			return truncate(`${toolCall.name}`, 120);
	}
}

function getThreadName(sessionPath: string): string {
	return path.basename(sessionPath, ".jsonl");
}

function parseJsonLines(filePath: string): SessionLine[] {
	const content = fs.readFileSync(filePath, "utf8");
	const lines: SessionLine[] = [];

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			lines.push(JSON.parse(line) as SessionLine);
		} catch {
			/* ignore malformed line */
		}
	}

	return lines;
}

function summarizeThreadSession(sessionPath: string, parentSessionFile?: string): SubagentCard {
	const thread = getThreadName(sessionPath);
	let latestAction = "";
	let outputPreview = "";
	let toolPreview = "";

	for (const line of parseJsonLines(sessionPath)) {
		if (line.type !== "message" || !line.message) continue;
		const message = line.message;
		if (message.role === "user") {
			const text = extractText(message.content);
			if (text) latestAction = text;
		}
		if (message.role === "assistant") {
			const text = extractText(message.content);
			if (text) outputPreview = text;
			const preview = summarizeToolCall(message.content);
			if (preview) toolPreview = preview;
		}
	}

	return {
		thread,
		sessionPath,
		latestAction,
		outputPreview,
		toolPreview,
		accumulatedCost: 0,
		status: "unknown",
		parentSessionFile,
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

function isDoneResult(result: DispatchItem["result"]): boolean {
	return !!result && result.exitCode === 0 && result.stopReason !== "aborted" && result.stopReason !== "error";
}

function isEscalatedResult(result: DispatchItem["result"]): boolean {
	return !!result && result.stopReason === "escalated";
}

function isAbortedResult(result: DispatchItem["result"]): boolean {
	return !!result && (result.stopReason === "aborted" || (typeof result.exitCode === "number" && result.exitCode !== 0));
}

function mergeParentDispatchDetails(cards: Map<string, SubagentCard>, parentBranchEntries: unknown[]): void {
	for (const entry of parentBranchEntries) {
		if (typeof entry !== "object" || entry === null) continue;
		const line = entry as SessionLine & { message?: SessionMessage };
		if (line.type !== "message" || line.message?.role !== "toolResult") continue;
		if (line.message.toolName !== "dispatch") continue;

		const details = line.message.details as { items?: DispatchItem[] } | undefined;
		if (!details?.items) continue;

		for (const item of details.items) {
			if (!item.thread) continue;
			const card = cards.get(item.thread) ?? {
				thread: item.thread,
				sessionPath: "",
				latestAction: "",
				outputPreview: "",
				toolPreview: "",
				accumulatedCost: 0,
				status: "unknown",
			};

			card.latestAction = item.action ?? card.latestAction;
			card.accumulatedCost += extractUsageCost(item.result?.usage?.cost);
			if (isEscalatedResult(item.result)) {
				card.status = "escalated";
			} else if (isAbortedResult(item.result)) {
				card.status = "aborted";
			} else if (isDoneResult(item.result)) {
				card.status = "done";
			}

			cards.set(item.thread, card);
		}
	}
}

export function collectSubagentCards(cwd: string, parentBranchEntries: unknown[]): SubagentCard[] {
	const threadsDir = path.join(cwd, ".pi", "threads");
	const state = loadThreadsState(cwd);
	const cards = new Map<string, SubagentCard>();

	if (fs.existsSync(threadsDir)) {
		for (const entry of fs.readdirSync(threadsDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name === "state.json") continue;
			const sessionPath = path.join(threadsDir, entry.name);
			const thread = getThreadName(sessionPath);
			cards.set(thread, summarizeThreadSession(sessionPath, state.parentBySession[path.resolve(sessionPath)]));
		}
	}

	mergeParentDispatchDetails(cards, parentBranchEntries);

	for (const card of cards.values()) {
		if (!card.sessionPath) {
			card.sessionPath = path.join(threadsDir, `${card.thread}.jsonl`);
		}
		if (card.parentSessionFile === undefined) {
			card.parentSessionFile = state.parentBySession[path.resolve(card.sessionPath)];
		}
	}

	return [...cards.values()].sort((a, b) => a.thread.localeCompare(b.thread));
}

