/**
 * Episode Sidebar — centered overlay showing episode history for a thread.
 *
 * Parses the thread's JSONL session file, reconstructs episodes (user→assistant
 * cycles), and displays them newest-first in a scrollable, collapsible list.
 */

import * as fs from "node:fs";

import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { getThreadSessionPath, wrapText } from "../helpers.ts";

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

async function parseSessionFile(filePath: string): Promise<ParsedMessage[]> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(filePath, "utf-8");
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
			// Skip unparseable lines (last line may be partial from in-progress write)
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
	return truncateToWidth(oneLine, maxLen, "\u2026");
}

export async function openEpisodeSidebar(ctx: ExtensionContext, threadName: string, cwd: string, sessionId: string): Promise<void> {
	if (!sessionId) {
		ctx.ui.notify("Thread sidebar unavailable — session not initialized yet", "warn");
		return;
	}
	const sessionPath = getThreadSessionPath(cwd, sessionId, threadName);
	const messages = await parseSessionFile(sessionPath);
	const episodes = buildEpisodes(messages);

	// Reverse for newest-first display
	const reversed = [...episodes].reverse();

	ctx.ui.custom(
		(tui: { requestRender: () => void }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, _kb: unknown, done: (val: undefined) => void) => {
			let selectedIndex = 0;
			let scrollOffset = 0;
			const expanded = new Set<number>(); // indices of expanded episodes

			/**
			 * Build all content lines and track which line index each episode starts at.
			 * Returns { lines, episodeStartLines } where episodeStartLines[i] is the
			 * line index in `lines` where reversed[i]'s header appears.
			 */
			function buildAllLines(width: number): { lines: string[]; episodeStartLines: number[] } {
				const lines: string[] = [];
				const episodeStartLines: number[] = [];
				const innerWidth = width - 2; // padding

				if (reversed.length === 0) {
					lines.push(theme.fg("muted", "  No episodes found"));
					return { lines, episodeStartLines };
				}

				for (let i = 0; i < reversed.length; i++) {
					const ep = reversed[i];
					const isSelected = i === selectedIndex;
					const isExpanded = expanded.has(i);
					const prefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
					const expandIcon = isExpanded ? "▾" : "▸";

					// Record the line where this episode starts
					episodeStartLines.push(lines.length);

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
						const userLines = wrapText(ep.userText, innerWidth - 6);
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
							const respLines = wrapText(ep.assistantText, innerWidth - 6);
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

				return { lines, episodeStartLines };
			}

			/**
			 * Compute the usable viewport height for content lines.
			 * The overlay is maxHeight 80% of terminal rows.
			 * Subtract: top border (1) + header (3 lines: title, subtitle, blank) + help line (1) + spacer (1) + bottom border (1) = ~7
			 * Plus scroll indicator lines take space from the viewport, but we account for
			 * those dynamically.
			 */
			function getViewportHeight(): number {
				const termRows = process.stdout.rows || 24;
				const overlayHeight = Math.floor(termRows * 0.8);
				// top border(1) + title(1) + subtitle(1) + blank(1) + spacer(1) + help(1) + bottom border(1) = 7
				const chrome = 7;
				return Math.max(3, overlayHeight - chrome);
			}

			/**
			 * Ensure scrollOffset keeps the selected episode visible.
			 */
			function adjustScroll(episodeStartLines: number[], allLineCount: number): void {
				const vpHeight = getViewportHeight();
				if (allLineCount <= vpHeight) {
					scrollOffset = 0;
					return;
				}

				if (episodeStartLines.length === 0) return;

				const selectedStart = episodeStartLines[selectedIndex] ?? 0;

				// If the selected episode header is above the viewport, scroll up
				if (selectedStart < scrollOffset) {
					scrollOffset = selectedStart;
				}

				// If the selected episode header is below the viewport, scroll down
				// We want the header line visible, so it should be < scrollOffset + vpHeight
				if (selectedStart >= scrollOffset + vpHeight) {
					scrollOffset = selectedStart - vpHeight + 1;
				}

				// Clamp
				const maxScroll = Math.max(0, allLineCount - vpHeight);
				scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
			}

			/**
			 * Build the final visible lines with scroll indicators and header.
			 */
			function buildVisibleContent(width: number): string[] {
				const { lines: allLines, episodeStartLines } = buildAllLines(width);

				// Adjust scroll to keep selection visible
				adjustScroll(episodeStartLines, allLines.length);

				const vpHeight = getViewportHeight();
				const totalLines = allLines.length;
				const needsScroll = totalLines > vpHeight;

				// Determine how many lines we can show (reserve space for indicators)
				let usableHeight = vpHeight;
				let showAbove = false;
				let showBelow = false;

				if (needsScroll) {
					if (scrollOffset > 0) {
						showAbove = true;
						usableHeight--;
					}
					const remaining = totalLines - scrollOffset - usableHeight;
					if (remaining > 0) {
						showBelow = true;
						usableHeight--;
					}
					// Re-check: after reserving for below, does above still apply?
					// And after reserving for above, does below still apply?
					if (showBelow && !showAbove && scrollOffset > 0) {
						showAbove = true;
						usableHeight--;
					}
					if (showAbove && !showBelow) {
						const remainAfter = totalLines - scrollOffset - usableHeight;
						if (remainAfter > 0) {
							showBelow = true;
							usableHeight--;
						}
					}
				}

				usableHeight = Math.max(1, usableHeight);

				const visibleSlice = allLines.slice(scrollOffset, scrollOffset + usableHeight);

				// Build output lines
				const output: string[] = [];

				// Header with scroll position
				const posIndicator = reversed.length > 0
					? ` (${selectedIndex + 1}/${reversed.length})`
					: "";
				output.push(theme.fg("accent", theme.bold(` 🧵 ${threadName}${posIndicator}`)));
				output.push(theme.fg("muted", `  ${episodes.length} episode${episodes.length !== 1 ? "s" : ""}`));
				output.push("");

				if (showAbove) {
					output.push(theme.fg("dim", `  ▲ more above (${scrollOffset} lines)`));
				}

				for (const line of visibleSlice) {
					output.push(line);
				}

				if (showBelow) {
					const belowCount = totalLines - (scrollOffset + usableHeight);
					output.push(theme.fg("dim", `  ▼ ${belowCount} more below`));
				}

				return output;
			}

			const container = new Container();
			const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
			container.addChild(topBorder);

			const contentText = new Text("", 0, 0);
			container.addChild(contentText);

			// Help text
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("dim", "  ↑↓ navigate · enter expand/collapse · ^U/^D scroll · esc close"), 1, 0),
			);

			const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
			container.addChild(bottomBorder);

			let dirty = true;
			let lastWidth = 0;

			function updateContent(width: number) {
				const lines = buildVisibleContent(width);
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
					} else if (matchesKey(data, Key.pageUp) || data === "\x15") {
						// PgUp or Ctrl+U: scroll up by half viewport
						const vpHeight = getViewportHeight();
						const jump = Math.max(1, Math.floor(vpHeight / 2));
						scrollOffset = Math.max(0, scrollOffset - jump);
						// Also move selection up to stay in view
						const { episodeStartLines } = buildAllLines(lastWidth || 80);
						// Find the first episode visible after scroll
						for (let i = 0; i < episodeStartLines.length; i++) {
							if (episodeStartLines[i] >= scrollOffset) {
								if (selectedIndex > i) {
									selectedIndex = i;
								}
								break;
							}
						}
						dirty = true;
						tui.requestRender();
					} else if (matchesKey(data, Key.pageDown) || data === "\x04") {
						// PgDn or Ctrl+D: scroll down by half viewport
						const vpHeight = getViewportHeight();
						const jump = Math.max(1, Math.floor(vpHeight / 2));
						const { lines: allLines, episodeStartLines } = buildAllLines(lastWidth || 80);
						const maxScroll = Math.max(0, allLines.length - vpHeight);
						scrollOffset = Math.min(maxScroll, scrollOffset + jump);
						// Also move selection down to stay in view
						for (let i = episodeStartLines.length - 1; i >= 0; i--) {
							if (episodeStartLines[i] < scrollOffset + vpHeight) {
								if (selectedIndex < i && episodeStartLines[i] >= scrollOffset) {
									selectedIndex = i;
								} else if (episodeStartLines[selectedIndex] < scrollOffset) {
									// Current selection scrolled above viewport, snap to first visible
									for (let j = 0; j < episodeStartLines.length; j++) {
										if (episodeStartLines[j] >= scrollOffset) {
											selectedIndex = j;
											break;
										}
									}
								}
								break;
							}
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
