export interface TextPart {
	type: "text";
	text: string;
}

export interface ToolCallPart {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}

export interface UnknownPart {
	type: string;
	[key: string]: unknown;
}

export type EpisodeContentPart = TextPart | ToolCallPart | UnknownPart;

export interface AssistantEpisodeMessage {
	role: "assistant";
	content: readonly EpisodeContentPart[];
}

export interface ToolResultEpisodeMessage {
	role: "toolResult";
	toolName?: string;
	isError?: boolean;
	content: readonly EpisodeContentPart[];
}

export interface OtherEpisodeMessage {
	role: string;
	content?: readonly EpisodeContentPart[];
	[key: string]: unknown;
}

export type EpisodeMessage = AssistantEpisodeMessage | ToolResultEpisodeMessage | OtherEpisodeMessage;

function summarizeInline(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isTextPart(part: EpisodeContentPart): part is TextPart {
	return part.type === "text" && typeof part.text === "string";
}

function isToolCallPart(part: EpisodeContentPart): part is ToolCallPart {
	return part.type === "toolCall" && typeof part.name === "string";
}

function summarizeToolCall(part: ToolCallPart): string {
	if (part.name === "bash") {
		const command = typeof part.arguments.command === "string" ? part.arguments.command : "";
		return `bash ${summarizeInline(command, 140) || "(no command)"}`;
	}

	const serializedArguments = JSON.stringify(part.arguments);
	return `${part.name} ${summarizeInline(serializedArguments, 140)}`.trim();
}

function summarizeToolResult(message: ToolResultEpisodeMessage): string {
	const toolName = message.toolName?.trim() || "tool";
	const rawText = message.content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
	const summary = summarizeInline(rawText, 200) || "(no textual output)";
	const status = message.isError ? "error" : "ok";
	return `${toolName} (${status}): ${summary}`;
}

function collectAssistantText(message: AssistantEpisodeMessage): string {
	return message.content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function isAssistantMessage(message: EpisodeMessage): message is AssistantEpisodeMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function isToolResultMessage(message: EpisodeMessage): message is ToolResultEpisodeMessage {
	return message.role === "toolResult" && Array.isArray(message.content);
}

export function buildEpisode(messages: readonly EpisodeMessage[]): string {
	const toolCallLines: string[] = [];
	const toolResultLines: string[] = [];
	const assistantBlocks: string[] = [];

	for (const message of messages) {
		if (isAssistantMessage(message)) {
			for (const part of message.content) {
				if (isToolCallPart(part)) {
					toolCallLines.push(summarizeToolCall(part));
				}
			}

			const assistantText = collectAssistantText(message);
			if (assistantText) {
				assistantBlocks.push(assistantText);
			}
			continue;
		}

		if (isToolResultMessage(message)) {
			toolResultLines.push(summarizeToolResult(message));
		}
	}

	const sections: string[] = [];

	if (toolCallLines.length > 0) {
		sections.push("TOOL CALLS:");
		for (const line of toolCallLines) {
			sections.push(`- ${line}`);
		}
	}

	if (toolResultLines.length > 0) {
		if (sections.length > 0) sections.push("");
		sections.push("TOOL RESULTS:");
		for (const line of toolResultLines) {
			sections.push(`- ${line}`);
		}
	}

	if (assistantBlocks.length > 0) {
		if (sections.length > 0) sections.push("");
		sections.push("THREAD RESPONSE:");
		sections.push(assistantBlocks.join("\n\n"));
	}

	return sections.join("\n") || "(no output)";
}
