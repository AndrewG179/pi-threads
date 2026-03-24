import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

export type SubagentStatus = "done" | "escalated" | "aborted" | "unknown";

export interface SubagentCard {
	thread: string;
	sessionPath: string;
	latestAction: string;
	outputLines: string[];
	outputPreview: string;
	outputTail: string[];
	toolPreview: string;
	accumulatedCost: number;
	status: SubagentStatus;
}

export function normalizeSessionPath(sessionPath: string): string;
export function normalizeSessionPath(sessionPath: string | undefined): string | undefined;
export function normalizeSessionPath(sessionPath: string | undefined): string | undefined {
	return sessionPath ? path.resolve(sessionPath) : undefined;
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
	const normalized = normalizeText(text);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function extractTextLines(parts: Message["content"] | undefined): string[] {
	if (!parts || parts.length === 0) return [];

	return parts
		.filter((part): part is Extract<Message["content"][number], { type: "text"; text: string }> => part.type === "text" && typeof part.text === "string")
		.flatMap((part) => part.text.split(/\r?\n/))
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function getThreadSessionPath(threadsDir: string, thread: string): string {
	const safeThread = thread.replace(/[^\w.-]+/g, "_");
	return path.join(threadsDir, `${safeThread}.jsonl`);
}

export function toSubagentStatus(result: { exitCode?: number | null; stopReason?: string } | undefined): SubagentStatus {
	if (!result) return "unknown";
	if (result.stopReason === "escalated") return "escalated";
	if (result.stopReason === "aborted" || result.stopReason === "error" || (typeof result.exitCode === "number" && result.exitCode !== 0)) {
		return "aborted";
	}
	return result.exitCode === 0 ? "done" : "unknown";
}

export function summarizeToolCall(parts: Message["content"] | undefined): string {
	if (!parts || parts.length === 0) return "";
	const toolCall = [...parts].reverse().find((part) => part.type === "toolCall" && typeof part.name === "string");
	if (!toolCall || toolCall.type !== "toolCall") return "";

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
			return truncate(toolCall.name, 120);
	}
}

export function summarizeOutputLines(messages: readonly Message[]): string[] {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") continue;
		for (const line of extractTextLines(message.content)) {
			lines.push(line);
		}
	}
	return lines;
}

export function summarizeOutputTail(messages: readonly Message[], maxLines = 8): string[] {
	return summarizeOutputLines(messages).slice(-maxLines);
}

export function summarizeOutputPreview(messages: readonly Message[]): string {
	const tail = summarizeOutputTail(messages, 1);
	return tail[0] ?? "";
}

export function summarizeRecentTool(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const preview = summarizeToolCall(messages[index].content);
		if (preview) return preview;
	}
	return "";
}
