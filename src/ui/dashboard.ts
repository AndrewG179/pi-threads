/**
 * Thread Dashboard — full-screen grid view of all threads.
 *
 * Opens via Ctrl+Shift+T or `/dashboard`. Shows thread cards in a grid
 * with keyboard navigation for browsing, deleting, and resetting threads.
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import { matchesKey, Key, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { ThreadRegistry } from "../state.ts";
import { listThreads, formatTokens, getThreadSessionPath, relativeTime } from "../helpers.ts";
import { getStatusIcon } from "./shared.ts";
import { openEpisodeSidebar } from "./sidebar.ts";

// ─── Helpers ───

/** Center a string within a given width, padding with spaces. */
function centerText(text: string, width: number): string {
	const tw = visibleWidth(text);
	if (tw >= width) return truncateToWidth(text, width);
	const leftPad = Math.floor((width - tw) / 2);
	const rightPad = width - tw - leftPad;
	return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

/** Pad a string to exactly `width` visible characters. */
function padRight(text: string, width: number): string {
	const tw = visibleWidth(text);
	if (tw >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - tw);
}

// ─── Dashboard Setup ───

export function setupDashboard(pi: ExtensionAPI, registry: ThreadRegistry) {
	const openDashboard = async (ctx: ExtensionContext) => {
		// Snapshot thread list (refreshed on mutations)
		let threads = listThreads(ctx.cwd);
		if (threads.length === 0) {
			ctx.ui.notify("No threads yet. Use dispatch to create threads.", "info");
			return;
		}

		const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			let selectedIndex = 0;
			const cols = 3;

			// Confirmation state
			let confirmMode: "delete" | "reset" | null = null;

			/** Refresh thread list from disk. */
			function refreshThreads() {
				threads = listThreads(ctx.cwd);
				if (threads.length === 0) {
					done(null);
				} else if (selectedIndex >= threads.length) {
					selectedIndex = threads.length - 1;
				}
			}

			/** Get status icon for a thread. */
			function statusIcon(name: string): string {
				return getStatusIcon(registry, name, theme);
			}

			/** Get mtime-based relative time for a thread. */
			function lastActivityStr(name: string): string {
				const lastActive = registry.lastActivity.get(name);
				if (lastActive) return relativeTime(lastActive);
				// Fallback to file mtime
				try {
					const sessionPath = getThreadSessionPath(ctx.cwd, name);
					const stat = fs.statSync(sessionPath);
					return relativeTime(stat.mtimeMs);
				} catch {
					return "";
				}
			}

			/** Render a single thread card as an array of lines, each exactly `cardWidth` visible chars. */
			function renderCard(name: string, cardWidth: number, selected: boolean): string[] {
				const innerWidth = cardWidth - 4; // "│ " + content + " │"

				const episodes = registry.episodeCounts.get(name) || 0;
				const stats = registry.threadStats.get(name);
				const icon = statusIcon(name);
				const activity = lastActivityStr(name);
				const ctxTokens = stats?.contextTokens ? formatTokens(stats.contextTokens) : "0";
				const compactions = stats?.compactionCount || 0;

				// Border styling
				const borderFg = selected ? "accent" : "dim";
				const b = (s: string) => theme.fg(borderFg, s);

				// Card lines
				const lines: string[] = [];

				// Top border
				lines.push(b("┌" + "─".repeat(cardWidth - 2) + "┐"));

				// Thread name with status icon
				const nameLine = icon + " " + theme.fg("accent", theme.bold(name));
				lines.push(b("│") + " " + padRight(nameLine, innerWidth) + " " + b("│"));

				// Episode count
				const epLine = `${episodes} episode${episodes !== 1 ? "s" : ""}`;
				lines.push(b("│") + " " + padRight(theme.fg("text", epLine), innerWidth) + " " + b("│"));

				// Context tokens
				const ctxLine = `${ctxTokens} ctx`;
				lines.push(b("│") + " " + padRight(theme.fg("muted", ctxLine), innerWidth) + " " + b("│"));

				// Last activity
				if (activity) {
					lines.push(b("│") + " " + padRight(theme.fg("muted", activity), innerWidth) + " " + b("│"));
				} else {
					lines.push(b("│") + " " + padRight("", innerWidth) + " " + b("│"));
				}

				// Compaction count (if > 0)
				if (compactions > 0) {
					const compLine = `compacted ${compactions}×`;
					lines.push(b("│") + " " + padRight(theme.fg("dim", compLine), innerWidth) + " " + b("│"));
				}

				// Bottom border
				lines.push(b("└" + "─".repeat(cardWidth - 2) + "┘"));

				return lines;
			}

			return {
				render(width: number): string[] {
					const output: string[] = [];

					// ── Title bar ──
					const title = "🧵 Thread Dashboard";
					output.push(theme.fg("accent", theme.bold(centerText(title, width))));
					const helpText = "n=new  d=delete  r=reset  Enter=browse  Esc=close";
					output.push(theme.fg("dim", centerText(helpText, width)));
					output.push("");

					// ── Grid layout ──
					const gap = 2; // space between cards
					const numThreads = threads.length;
					const numCols = Math.min(cols, numThreads);
					const totalGap = gap * (numCols - 1);
					const cardWidth = Math.max(20, Math.floor((width - totalGap) / numCols));

					// Render rows of cards
					for (let rowStart = 0; rowStart < numThreads; rowStart += cols) {
						const rowThreads = threads.slice(rowStart, rowStart + cols);
						const rowCards: string[][] = [];

						for (let c = 0; c < rowThreads.length; c++) {
							const globalIdx = rowStart + c;
							const isSelected = globalIdx === selectedIndex;
							rowCards.push(renderCard(rowThreads[c], cardWidth, isSelected));
						}

						// Pad all cards in this row to the same height
						const maxHeight = Math.max(...rowCards.map((c) => c.length));
						for (const card of rowCards) {
							while (card.length < maxHeight) {
								card.push(" ".repeat(cardWidth));
							}
						}

						// Zip card lines into rows
						for (let row = 0; row < maxHeight; row++) {
							const parts: string[] = [];
							for (let c = 0; c < rowCards.length; c++) {
								parts.push(rowCards[c][row]);
							}
							output.push(parts.join(" ".repeat(gap)));
						}

						// Space between grid rows
						output.push("");
					}

					// ── Confirmation prompt ──
					if (confirmMode) {
						const threadName = threads[selectedIndex];
						const verb = confirmMode === "delete" ? "Delete" : "Reset";
						const prompt = `${verb} "${threadName}"? (y/n)`;
						output.push("");
						output.push(theme.fg("warning", centerText(prompt, width)));
					}

					return output;
				},

				invalidate() {},

				handleInput(data: string) {
					// ── Confirmation mode ──
					if (confirmMode) {
						if (data === "y" || data === "Y") {
							const threadName = threads[selectedIndex];
							if (confirmMode === "delete") {
								// Delete the session file and clear registry state
								try {
									const sessionPath = getThreadSessionPath(ctx.cwd, threadName);
									fs.unlinkSync(sessionPath);
								} catch { /* ignore */ }
								registry.deleteThread(threadName);
								refreshThreads();
							} else if (confirmMode === "reset") {
								// Delete session file but preserve thread identity (episode count stays)
								try {
									const sessionPath = getThreadSessionPath(ctx.cwd, threadName);
									fs.unlinkSync(sessionPath);
								} catch { /* ignore */ }
								// Recreate session file with valid JSONL header so listThreads still sees the thread
								try {
									const header = JSON.stringify({ type: "session", id: randomUUID(), cwd: ctx.cwd });
									fs.writeFileSync(getThreadSessionPath(ctx.cwd, threadName), header + "\n", 'utf-8');
								} catch { /* ignore */ }
								registry.resetThread(threadName);
								refreshThreads();
							}
							confirmMode = null;
							tui.requestRender();
							return;
						}
						if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
							confirmMode = null;
							tui.requestRender();
							return;
						}
						// Ignore all other input in confirmation mode
						return;
					}

					// ── Normal navigation ──
					const numThreads = threads.length;
					const row = Math.floor(selectedIndex / cols);
					const col = selectedIndex % cols;
					const totalRows = Math.ceil(numThreads / cols);

					if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}

					if (matchesKey(data, Key.up) || data === "k") {
						if (row > 0) {
							const newIdx = Math.min((row - 1) * cols + col, numThreads - 1);
							selectedIndex = newIdx;
						}
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.down) || data === "j") {
						if (row < totalRows - 1) {
							const newIdx = Math.min((row + 1) * cols + col, numThreads - 1);
							selectedIndex = newIdx;
						}
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.left) || data === "h") {
						if (selectedIndex > 0) selectedIndex--;
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.right) || data === "l") {
						if (selectedIndex < numThreads - 1) selectedIndex++;
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						done(threads[selectedIndex]);
						return;
					}

					if (data === "n") {
						ctx.ui.notify("Threads are created automatically via dispatch.", "info");
						return;
					}

					if (data === "d") {
						if (registry.runningThreads.has(threads[selectedIndex])) {
							ctx.ui.notify(`Thread "${threads[selectedIndex]}" is currently busy`, "warning");
							return;
						}
						confirmMode = "delete";
						tui.requestRender();
						return;
					}

					if (data === "r") {
						if (registry.runningThreads.has(threads[selectedIndex])) {
							ctx.ui.notify(`Thread "${threads[selectedIndex]}" is currently busy`, "warning");
							return;
						}
						confirmMode = "reset";
						tui.requestRender();
						return;
					}
				},
			};
		});

		// If a thread was selected, open its episode sidebar
		if (result) {
			openEpisodeSidebar(ctx, result, ctx.cwd);
		}
	};

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open Thread Dashboard",
		handler: openDashboard,
	});

	pi.registerCommand("dashboard", {
		description: "Open the Thread Dashboard",
		handler: async (_args, ctx) => openDashboard(ctx),
	});
}
