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
	id?: string;
	parentId?: string | null;
	message?: SessionMessage;
}

interface DispatchItem {
	thread?: string;
	action?: string;
	episode?: string;
	result?: {
		sessionPath?: string;
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

export function loadSessionBranchFromFile(sessionPath: string): SessionLine[] {
	const entries = parseJsonLines(sessionPath).filter((entry) => entry.type !== "session");
	if (entries.length === 0) return [];

	const byId = new Map<string, SessionLine>();
	const referencedParents = new Set<string>();
	for (const entry of entries) {
		if (entry.id) byId.set(entry.id, entry);
		if (entry.parentId) referencedParents.add(entry.parentId);
	}

	let leaf = [...entries].reverse().find((entry) => entry.id && !referencedParents.has(entry.id));
	if (!leaf) {
		leaf = [...entries].reverse().find((entry) => Boolean(entry.id)) ?? entries[entries.length - 1];
	}

	if (!leaf.id) return entries;

	const branch: SessionLine[] = [];
	let current: SessionLine | undefined = leaf;
	while (current) {
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	return branch.reverse();
}

function summarizeThreadSession(sessionPath: string, parentSessionFile?: string): SubagentCard {
	const thread = getThreadName(sessionPath);
	let latestAction = "";
	let outputPreview = "";
	let toolPreview = "";

	for (const line of loadSessionBranchFromFile(sessionPath)) {
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

function getDispatchStatus(result: DispatchItem["result"]): SubagentCard["status"] {
	if (!result) return "unknown";
	if (result.stopReason === "escalated") return "escalated";
	if (result.stopReason === "aborted" || (typeof result.exitCode === "number" && result.exitCode !== 0)) return "aborted";
	if (result.exitCode === 0 && result.stopReason !== "error") return "done";
	return "unknown";
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
			const card = cards.get(item.thread);
			if (!card) continue;

			card.latestAction = item.action ?? card.latestAction;
			card.accumulatedCost += extractUsageCost(item.result?.usage?.cost);
			card.status = getDispatchStatus(item.result);

			cards.set(item.thread, card);
		}
	}
}

function isThreadSessionFile(threadsDir: string, sessionPath: string): boolean {
	const resolvedThreadsDir = path.resolve(threadsDir);
	const resolvedSessionPath = path.resolve(sessionPath);
	const relativePath = path.relative(resolvedThreadsDir, resolvedSessionPath);

	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return false;
	if (!resolvedSessionPath.endsWith(".jsonl") || path.basename(resolvedSessionPath) === "state.json") return false;

	try {
		return fs.statSync(resolvedSessionPath).isFile();
	} catch {
		return false;
	}
}

function resolveDispatchSessionPath(threadsDir: string, item: DispatchItem): string | undefined {
	const candidateSessionPaths = [
		typeof item.result?.sessionPath === "string" ? item.result.sessionPath : undefined,
		item.thread ? path.join(threadsDir, `${item.thread}.jsonl`) : undefined,
	];

	for (const candidateSessionPath of candidateSessionPaths) {
		if (!candidateSessionPath) continue;
		const resolvedSessionPath = path.resolve(candidateSessionPath);
		if (isThreadSessionFile(threadsDir, resolvedSessionPath)) return resolvedSessionPath;
	}

	return undefined;
}

function collectPersistedCurrentParentSessions(
	threadsDir: string,
	parentBySession: Record<string, string>,
	currentParentSessionFile?: string,
): Map<string, string> {
	if (!currentParentSessionFile) return new Map<string, string>();

	const resolvedParentSessionFile = path.resolve(currentParentSessionFile);
	const sessions = new Map<string, string>();

	for (const [childSessionPath, parentSessionPath] of Object.entries(parentBySession)) {
		if (path.resolve(parentSessionPath) !== resolvedParentSessionFile) continue;
		if (!isThreadSessionFile(threadsDir, childSessionPath)) continue;

		const resolvedChildSessionPath = path.resolve(childSessionPath);
		sessions.set(getThreadName(resolvedChildSessionPath), resolvedChildSessionPath);
	}

	return sessions;
}

function collectCurrentBranchSessions(threadsDir: string, parentBranchEntries: unknown[]): Map<string, string> {
	const sessions = new Map<string, string>();

	for (const entry of parentBranchEntries) {
		if (typeof entry !== "object" || entry === null) continue;
		const line = entry as SessionLine & { message?: SessionMessage };
		if (line.type !== "message" || line.message?.role !== "toolResult") continue;
		if (line.message.toolName !== "dispatch") continue;

		const details = line.message.details as { items?: DispatchItem[] } | undefined;
		if (!details?.items) continue;

		for (const item of details.items) {
			if (!item.thread) continue;
			const sessionPath = resolveDispatchSessionPath(threadsDir, item);
			if (!sessionPath) continue;
			sessions.set(item.thread, sessionPath);
		}
	}

	return sessions;
}

export function collectSubagentCards(
	cwd: string,
	parentBranchEntries: unknown[],
	currentParentSessionFile?: string,
): SubagentCard[] {
	const threadsDir = path.join(cwd, ".pi", "threads");
	const state = loadThreadsState(cwd);
	const cards = new Map<string, SubagentCard>();

	for (const [thread, sessionPath] of collectPersistedCurrentParentSessions(
		threadsDir,
		state.parentBySession,
		currentParentSessionFile,
	)) {
		const parentSessionFile = state.parentBySession[path.resolve(sessionPath)];
		const card = summarizeThreadSession(sessionPath, parentSessionFile);
		cards.set(thread, { ...card, thread });
	}

	for (const [thread, sessionPath] of collectCurrentBranchSessions(threadsDir, parentBranchEntries)) {
		const parentSessionFile = state.parentBySession[path.resolve(sessionPath)];
		const card = summarizeThreadSession(sessionPath, parentSessionFile);
		cards.set(thread, { ...card, thread });
	}

	mergeParentDispatchDetails(cards, parentBranchEntries);

	return [...cards.values()].sort((a, b) => a.thread.localeCompare(b.thread));
}
