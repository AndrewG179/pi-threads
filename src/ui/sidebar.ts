/**
 * Episode Sidebar — centered overlay showing episode history for a thread.
 *
 * Parses the thread's JSONL session file, reconstructs episodes (user→assistant
 * cycles), and displays them newest-first in a scrollable, collapsible list.
 */

import * as fs from "node:fs";

import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { getThreadSessionPath } from "../helpers.ts";

// ─── Types ───

interface ParsedMessage {
	id?: string;
	parentId?: string;
	role: string;
	content: unknown;
	timestamp?: number;
}

interface Episode {
	number: number;
	timestamp: number;
	userText: string;
	assistantText: string;
	toolCalls: string[];
}

// ─── JSONL Parsing ───

function parseSessionFile(filePath: string): ParsedMessage[] {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const lines = raw.split("\n").filter((l) => l.trim());
	const messages: ParsedMessage[] = [];

	for (let i = 0; i < lines.length; i++) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type === "message" && entry.message) {
				const msg = entry.message;
				messages.push({
					id: entry.id,
					parentId: entry.parentId,
					role: msg.role,
					content: msg.content,
					timestamp: msg.timestamp ?? entry.timestamp,
				});
			}
		} catch {
			// Skip unparseable lines (may be in-progress write on last line)
			if (i < lines.length - 1) {
				// Only silently skip the last line; earlier failures are unexpected but non-fatal
			}
		}
	}

	return messages;
}

/**
 * Follow the active branch to the leaf by building a parent→children map
 * and always picking the last child (most recent branch).
 */
function followActiveBranch(messages: ParsedMessage[]): ParsedMessage[] {
	if (messages.length === 0) return [];

	// If messages don't have id/parentId, treat them as linear
	const hasTree = messages.some((m) => m.id || m.parentId);
	if (!hasTree) return messages;

	// Build parent→children index
	// Messages whose parentId points to a non-message entry (e.g. thinking_level_change,
	// model_change) are treated as root-level, since those entries were filtered out
	// during parsing.
	const allIds = new Set(messages.filter((m) => m.id).map((m) => m.id!));
	const childrenOf = new Map<string, ParsedMessage[]>();
	childrenOf.set("__root__", []);

	for (const m of messages) {
		const parentKey = (m.parentId && allIds.has(m.parentId)) ? m.parentId : "__root__";
		if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
		childrenOf.get(parentKey)!.push(m);
	}

	// Walk from root, always picking last child (newest branch)
	const branch: ParsedMessage[] = [];
	let current = "__root__";

	while (childrenOf.has(current) && childrenOf.get(current)!.length > 0) {
		const kids = childrenOf.get(current)!;
		const next = kids[kids.length - 1]; // last = active branch
		branch.push(next);
		current = next.id ?? "";
	}

	return branch;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: { type: string; text?: string; name?: string }) => c.type === "text" && c.text)
			.map((c: { type: string; text?: string; name?: string }) => c.text)
			.join(" ");
	}
	return "";
}

function extractToolCalls(msg: ParsedMessage): string[] {
	if (!Array.isArray(msg.content)) return [];
	return msg.content
		.filter((c: { type: string; text?: string; name?: string }) => c.type === "toolCall")
		.map((c: { type: string; text?: string; name?: string }) => c.name || "unknown");
}

function buildEpisodes(messages: ParsedMessage[]): Episode[] {
	const branch = followActiveBranch(messages);
	const userAndAssistant = branch.filter(
		(m) => m.role === "user" || m.role === "assistant",
	);

	const episodes: Episode[] = [];
	let episodeNum = 0;

	let i = 0;
	while (i < userAndAssistant.length) {
		const msg = userAndAssistant[i];

		if (msg.role === "user") {
			episodeNum++;
			const userText = extractText(msg.content);
			const timestamp = msg.timestamp ?? 0;

			// Collect following assistant messages + tool calls until next user
			let assistantText = "";
			const toolCalls: string[] = [];
			let j = i + 1;
			while (j < userAndAssistant.length && userAndAssistant[j].role === "assistant") {
				const aMsg = userAndAssistant[j];
				const text = extractText(aMsg.content);
				if (text) assistantText = text; // keep last assistant text
				toolCalls.push(...extractToolCalls(aMsg));
				j++;
			}

			episodes.push({
				number: episodeNum,
				timestamp,
				userText,
				assistantText,
				toolCalls,
			});

			i = j;
		} else {
			// Orphan assistant message without preceding user — skip
			i++;
		}
	}

	return episodes;
}

// ─── Sidebar Component ───

function formatTimestamp(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(text: string, maxLen: number): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	if (visibleWidth(oneLine) <= maxLen) return oneLine;
	return truncateToWidth(oneLine, maxLen - 1) + "…";
}

export function openEpisodeSidebar(ctx: { ui: { custom: (...args: unknown[]) => void } }, threadName: string, cwd: string): void {
	const sessionPath = getThreadSessionPath(cwd, threadName);
	const messages = parseSessionFile(sessionPath);
	const episodes = buildEpisodes(messages);

	// Reverse for newest-first display
	const reversed = [...episodes].reverse();

	ctx.ui.custom(
		(tui: { requestRender: () => void }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, _kb: unknown, done: (val: undefined) => void) => {
			let selectedIndex = 0;
			const expanded = new Set<number>(); // indices of expanded episodes

			function buildLines(width: number): string[] {
				const lines: string[] = [];
				const innerWidth = width - 2; // padding

				// Header
				lines.push(theme.fg("accent", theme.bold(` 🧵 ${threadName}`)));
				lines.push(theme.fg("muted", `  ${episodes.length} episode${episodes.length !== 1 ? "s" : ""}`));
				lines.push("");

				if (reversed.length === 0) {
					lines.push(theme.fg("muted", "  No episodes found"));
					return lines;
				}

				for (let i = 0; i < reversed.length; i++) {
					const ep = reversed[i];
					const isSelected = i === selectedIndex;
					const isExpanded = expanded.has(i);
					const prefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
					const expandIcon = isExpanded ? "▾" : "▸";

					// Episode header line
					const header = `${expandIcon} Episode ${ep.number}`;
					const ts = formatTimestamp(ep.timestamp);
					const headerLine = isSelected
						? theme.fg("accent", theme.bold(header)) + (ts ? theme.fg("dim", ` ${ts}`) : "")
						: theme.fg("text", header) + (ts ? theme.fg("dim", ` ${ts}`) : "");
					lines.push(prefix + truncateToWidth(headerLine, innerWidth));

					if (!isExpanded) {
						// Collapsed summary: user action truncated
						const actionSummary = truncate(ep.userText, innerWidth - 6);
						lines.push("    " + theme.fg("muted", actionSummary));

						// Tool calls compact
						if (ep.toolCalls.length > 0) {
							const toolStr = ep.toolCalls.slice(0, 4).join(", ");
							const extra = ep.toolCalls.length > 4 ? ` +${ep.toolCalls.length - 4}` : "";
							lines.push("    " + theme.fg("dim", `⚙ ${toolStr}${extra}`));
						}
					} else {
						// Expanded view
						lines.push("");

						// User action
						lines.push("    " + theme.fg("accent", "Action:"));
						const userLines = wrapForSidebar(ep.userText, innerWidth - 6);
						for (const ul of userLines) {
							lines.push("      " + ul);
						}

						// Tool calls
						if (ep.toolCalls.length > 0) {
							lines.push("");
							lines.push("    " + theme.fg("accent", "Tools:"));
							for (const tc of ep.toolCalls) {
								lines.push("      " + theme.fg("dim", `• ${tc}`));
							}
						}

						// Response
						if (ep.assistantText) {
							lines.push("");
							lines.push("    " + theme.fg("accent", "Response:"));
							const respLines = wrapForSidebar(ep.assistantText, innerWidth - 6);
							for (const rl of respLines.slice(0, 20)) {
								lines.push("      " + rl);
							}
							if (respLines.length > 20) {
								lines.push("      " + theme.fg("dim", `... (${respLines.length - 20} more lines)`));
							}
						}
					}

					// Separator
					lines.push("");
				}

				return lines;
			}

			function wrapForSidebar(text: string, maxWidth: number): string[] {
				if (!text) return [""];
				const result: string[] = [];
				for (const paragraph of text.split("\n")) {
					if (!paragraph.trim()) {
						result.push("");
						continue;
					}
					const words = paragraph.split(/\s+/);
					let current = "";
					for (const word of words) {
						if (current.length + word.length + 1 > maxWidth && current.length > 0) {
							result.push(current);
							current = word;
						} else {
							current = current ? current + " " + word : word;
						}
					}
					if (current) result.push(current);
				}
				return result.length > 0 ? result : [""];
			}

			const container = new Container();
			const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
			container.addChild(topBorder);

			const contentText = new Text("", 0, 0);
			container.addChild(contentText);

			// Help text
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("dim", "  ↑↓ navigate · enter expand/collapse · esc close"), 1, 0),
			);

			const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
			container.addChild(bottomBorder);

			let dirty = true;
			let lastWidth = 0;

			function updateContent(width: number) {
				const lines = buildLines(width);
				contentText.setText(lines.join("\n"));
				lastWidth = width;
				dirty = false;
			}

			// Initial render
			updateContent(80);

			return {
				render: (w: number) => {
					if (dirty || w !== lastWidth) {
						updateContent(w);
					}
					return container.render(w);
				},
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, Key.up)) {
						if (selectedIndex > 0) {
							selectedIndex--;
							dirty = true;
						}
						tui.requestRender();
					} else if (matchesKey(data, Key.down)) {
						if (selectedIndex < reversed.length - 1) {
							selectedIndex++;
							dirty = true;
						}
						tui.requestRender();
					} else if (matchesKey(data, Key.enter)) {
						if (expanded.has(selectedIndex)) {
							expanded.delete(selectedIndex);
						} else {
							expanded.add(selectedIndex);
						}
						dirty = true;
						tui.requestRender();
					} else if (matchesKey(data, Key.escape)) {
						done(undefined);
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "70%",
				minWidth: 50,
				maxHeight: "80%",
			},
		},
	);
}
