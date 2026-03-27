/**
 * Thread Manager — unified overlay combining list + grid views.
 *
 * Opens via Ctrl+Alt+T, Ctrl+Shift+T, `/threads`, or `/thread-delete`.
 * Tab toggles between a SelectList view and a card-grid (dashboard) view.
 * Both views share the same data, delete/reset logic, and overlay chrome.
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	matchesKey,
	Key,
	visibleWidth,
	truncateToWidth,
} from "@mariozechner/pi-tui";

import type { ThreadRegistry } from "../state.ts";
import { listThreadSessions, type ThreadSessionInfo, formatTokens, relativeTime, removeThreadName } from "../helpers.ts";
import { getStatusIcon } from "./shared.ts";
import { openEpisodeSidebar } from "./sidebar.ts";

// ─── Layout helpers ───

function centerText(text: string, width: number): string {
	const tw = visibleWidth(text);
	if (tw >= width) return truncateToWidth(text, width);
	const leftPad = Math.floor((width - tw) / 2);
	const rightPad = width - tw - leftPad;
	return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

function padRight(text: string, width: number): string {
	const tw = visibleWidth(text);
	if (tw >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - tw);
}

// ─── Setup ───

export function setupThreadManager(
	pi: ExtensionAPI,
	registry: ThreadRegistry,
): void {
	const openManager = async (ectx: ExtensionContext) => {
		// ── Async prefetch ──
		let mtimeCache = new Map<string, number>();

		async function refreshThreadData(): Promise<ThreadSessionInfo[]> {
			const entries = await listThreadSessions(ectx.cwd, registry.sessionId);
			const newCache = new Map<string, number>();
			for (const entry of entries) {
				try {
					const stat = await fs.promises.stat(entry.sessionPath);
					newCache.set(entry.threadName, stat.mtimeMs);
				} catch { /* thread may vanish between list and stat */ }
			}
			mtimeCache = newCache;
			return entries;
		}

		let threadEntries = await refreshThreadData();
		if (threadEntries.length === 0) {
			ectx.ui.notify("No threads yet. Use dispatch to create threads.", "info");
			return;
		}

		const result = await ectx.ui.custom<ThreadSessionInfo | null>(
			(tui, theme, _kb, done) => {
				// ── Shared state ──
				type ViewMode = "list" | "grid";
				let view: ViewMode = "list";
				let selectedIndex = 0;
				let scrollOffset = 0;
				let pendingOperation = false;
				let overlayClosed = false;
				let lastRenderWidth = process.stdout.columns || 80;

				function getGridCols(availableWidth: number): number {
					const minCardWidth = 24;
					const gap = 2;
					const cols = Math.floor((availableWidth + gap) / (minCardWidth + gap));
					return Math.max(1, Math.min(cols, 4));
				}

				function closeOverlay(value: ThreadSessionInfo | null) {
					if (overlayClosed) return;
					overlayClosed = true;
					done(value);
				}

				// Confirmation state (shared across both views)
				let confirmMode: "delete" | "reset" | "clear-all" | null = null;

				// ── SelectList (for list view) ──
				let selectItems: SelectItem[] = buildSelectItems();
				let selectList = buildSelectList();

				function buildSelectItems(): SelectItem[] {
					return threadEntries.map((entry) => {
						const threadName = entry.threadName;
						const count = registry.episodeCounts.get(threadName) || 0;
						const stats = registry.threadStats.get(threadName);
						const icon = getStatusIcon(registry, threadName, theme);
						const contextInfo = stats?.contextTokens
							? `${formatTokens(stats.contextTokens)} ctx`
							: "0 ctx";
						const mtimeMs = registry.lastActivity.get(threadName) || mtimeCache.get(threadName);
						const activity = mtimeMs ? relativeTime(mtimeMs) : "unknown";
						const description = `${count} ep · ${contextInfo} · ${activity}`;
						return {
							value: entry.sessionPath,
							label: `${icon} ${threadName}`,
							description,
						};
					});
				}

				function buildSelectList(): SelectList {
					const sl = new SelectList(selectItems, Math.min(selectItems.length, 20), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					sl.onSelect = (item) => {
						const entry = threadEntries.find((e) => e.sessionPath === item.value);
						if (entry) closeOverlay(entry);
						else closeOverlay(null);
					};
					sl.onCancel = () => closeOverlay(null);
					return sl;
				}

				function getEntryAt(index: number): ThreadSessionInfo | undefined {
					return threadEntries[index];
				}

				function syncSelectedIndexFromList() {
					const sel = selectList.getSelectedItem();
					if (!sel) return;
					const idx = threadEntries.findIndex((e) => e.sessionPath === sel.value);
					if (idx >= 0) selectedIndex = idx;
				}

				/** Rebuild SelectList after data changes. */
				function rebuildList(preserveSessionPath?: string) {
					selectItems = buildSelectItems();
					selectList = buildSelectList();
					if (selectItems.length === 0) return;

					let nextIndex = Math.max(0, Math.min(selectedIndex, selectItems.length - 1));
					if (preserveSessionPath) {
						const preservedIndex = selectItems.findIndex((item) => item.value === preserveSessionPath);
						if (preservedIndex >= 0) nextIndex = preservedIndex;
					}

					selectedIndex = nextIndex;
					selectList.setSelectedIndex(nextIndex);
				}

				// ── Shared helpers ──

				function lastActivityStr(name: string): string {
					const lastActive = registry.lastActivity.get(name);
					if (lastActive) return relativeTime(lastActive);
					const mtime = mtimeCache.get(name);
					if (mtime !== undefined) return relativeTime(mtime);
					return "";
				}

				// ── Delete / Reset (shared) ──

				function executeConfirmation() {
					if (pendingOperation) return;
					const entry = getEntryAt(selectedIndex);
					if (!entry) return;
					const { threadName, sessionPath } = entry;
					const mode = confirmMode;
					if (!mode) return;
					confirmMode = null;
					pendingOperation = true;

					void (async () => {
						try {
							if (mode === "clear-all") {
								let deletedCount = 0;
								for (const e of [...threadEntries]) {
									try {
										await fs.promises.unlink(e.sessionPath);
										await removeThreadName(ectx.cwd, registry.sessionId, e.threadName);
										registry.deleteThread(e.threadName);
										deletedCount++;
									} catch (e: any) {
										if (e?.code !== "ENOENT") { /* skip errors on individual threads */ }
									}
								}
								if (deletedCount === 0) {
									ectx.ui.notify(`Failed to clear threads`, "error");
								} else if (deletedCount < threadEntries.length) {
									ectx.ui.notify(`🗑️ Cleared ${deletedCount}/${threadEntries.length} threads (some failed)`, "warning");
								} else {
									ectx.ui.notify(`🗑️ Cleared ${deletedCount} thread${deletedCount !== 1 ? "s" : ""}`, "info");
								}
							} else if (mode === "delete") {
								try {
									await fs.promises.unlink(sessionPath);
								} catch (e: any) {
									if (e?.code !== "ENOENT") {
										ectx.ui.notify(`Failed to delete thread "${threadName}": ${e?.message}`, "error");
										return;
									}
								}
								await removeThreadName(ectx.cwd, registry.sessionId, threadName).catch(() => {});
								registry.deleteThread(threadName);
							} else {
								// Reset: delete session file, recreate with fresh header
								try {
									await fs.promises.unlink(sessionPath);
								} catch (e: any) {
									if (e?.code !== "ENOENT") {
										ectx.ui.notify(`Failed to reset thread "${threadName}": ${e?.message}`, "error");
										return;
									}
								}
								try {
									const header = JSON.stringify({
										type: "session",
										id: randomUUID(),
										cwd: ectx.cwd,
									});
									await fs.promises.writeFile(
										sessionPath,
										header + "\n",
										"utf-8",
									);
									registry.resetThread(threadName);
								} catch (e: any) {
									ectx.ui.notify(`Failed to reset thread "${threadName}": ${e?.message}`, "error");
									return;
								}
							}

							threadEntries = await refreshThreadData();
							if (threadEntries.length === 0) {
								if (!overlayClosed) closeOverlay(null);
								return;
							}
							if (selectedIndex >= threadEntries.length) {
								selectedIndex = threadEntries.length - 1;
							}
							rebuildList(sessionPath);
							if (!overlayClosed) tui.requestRender();
						} finally {
							pendingOperation = false;
						}
					})().catch((err) => {
						pendingOperation = false;
						ectx.ui.notify(`Thread operation failed: ${err?.message || err}`, "error");
					});
				}

				/** Shared confirm-mode input handler. Returns true if input was consumed. */
				function handleConfirmInput(data: string): boolean {
					if (!confirmMode) return false;
					if (data === "y" || data === "Y") {
						if (!pendingOperation) executeConfirmation();
						return true;
					}
					if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
						confirmMode = null;
						tui.requestRender();
						return true;
					}
					return true; // swallow other keys in confirm mode
				}

				// ── Grid-view card rendering (from dashboard) ──

				function renderCard(name: string, cardWidth: number, selected: boolean): string[] {
					const innerWidth = cardWidth - 4;
					const episodes = registry.episodeCounts.get(name) || 0;
					const stats = registry.threadStats.get(name);
					const icon = getStatusIcon(registry, name, theme);
					const activity = lastActivityStr(name);
					const ctxTokens = stats?.contextTokens ? formatTokens(stats.contextTokens) : "0";
					const compactions = stats?.compactionCount || 0;

					const borderFg = selected ? "accent" : "dim";
					const b = (s: string) => theme.fg(borderFg, s);
					const lines: string[] = [];

					lines.push(b("┌" + "─".repeat(cardWidth - 2) + "┐"));
					lines.push(b("│") + " " + padRight(icon + " " + theme.fg("accent", theme.bold(name)), innerWidth) + " " + b("│"));
					lines.push(b("│") + " " + padRight(theme.fg("text", `${episodes} episode${episodes !== 1 ? "s" : ""}`), innerWidth) + " " + b("│"));
					lines.push(b("│") + " " + padRight(theme.fg("muted", `${ctxTokens} ctx`), innerWidth) + " " + b("│"));
					lines.push(b("│") + " " + padRight(activity ? theme.fg("muted", activity) : "", innerWidth) + " " + b("│"));
					if (compactions > 0) {
						lines.push(b("│") + " " + padRight(theme.fg("dim", `compacted ${compactions}×`), innerWidth) + " " + b("│"));
					}
					lines.push(b("└" + "─".repeat(cardWidth - 2) + "┘"));

					return lines;
				}

				function getSelectedRowLineRange(
					numThreads: number,
					numCols: number,
					cardRowHeights: number[],
				): { rowLineStart: number; rowLineEnd: number } {
					const selectedGridRow = Math.floor(selectedIndex / numCols);
					let lineOffset = 0;
					for (let gr = 0; gr < selectedGridRow; gr++) {
						lineOffset += cardRowHeights[gr] + 1;
					}
					return { rowLineStart: lineOffset, rowLineEnd: lineOffset + cardRowHeights[selectedGridRow] };
				}

				function ensureSelectedVisible(
					allCardLines: string[],
					numThreads: number,
					numCols: number,
					cardRowHeights: number[],
					viewportHeight: number,
				) {
					const { rowLineStart, rowLineEnd } = getSelectedRowLineRange(numThreads, numCols, cardRowHeights);
					if (rowLineStart < scrollOffset) scrollOffset = rowLineStart;
					if (rowLineEnd > scrollOffset + viewportHeight) scrollOffset = rowLineEnd - viewportHeight;
					const maxScroll = Math.max(0, allCardLines.length - viewportHeight);
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
				}

				// ── Grid render ──

				function renderGrid(width: number): string[] {
					const output: string[] = [];
					const gap = 2;
					const numThreads = threadEntries.length;
					const numCols = Math.max(1, Math.min(getGridCols(width), numThreads));
					const totalGap = gap * (numCols - 1);
					const cardWidth = Math.max(20, Math.floor((width - totalGap) / numCols));

					const allCardLines: string[] = [];
					const cardRowHeights: number[] = [];

					for (let rowStart = 0; rowStart < numThreads; rowStart += numCols) {
						const rowEntries = threadEntries.slice(rowStart, rowStart + numCols);
						const rowCards: string[][] = [];
						for (let c = 0; c < rowEntries.length; c++) {
							const globalIdx = rowStart + c;
							rowCards.push(renderCard(rowEntries[c].threadName, cardWidth, globalIdx === selectedIndex));
						}
						const maxHeight = Math.max(...rowCards.map((c) => c.length));
						for (const card of rowCards) {
							while (card.length < maxHeight) card.push(" ".repeat(cardWidth));
						}
						for (let row = 0; row < maxHeight; row++) {
							const parts: string[] = [];
							for (let c = 0; c < rowCards.length; c++) parts.push(rowCards[c][row]);
							allCardLines.push(parts.join(" ".repeat(gap)));
						}
						cardRowHeights.push(maxHeight);
						allCardLines.push("");
					}

					if (confirmMode) {
						const verb = confirmMode === "clear-all" ? "Clear ALL threads" : confirmMode === "delete" ? "Delete" : "Reset";
						const threadName = confirmMode === "clear-all" ? `${threadEntries.length} threads` : (getEntryAt(selectedIndex)?.threadName ?? "");
						allCardLines.push("");
						allCardLines.push(theme.fg("warning", centerText(`${verb} "${threadName}"? (y/n)`, width)));
					}

					const viewportHeight = Math.max(1, (process.stdout.rows || 24) - 6);
					ensureSelectedVisible(allCardLines, numThreads, numCols, cardRowHeights, viewportHeight);

					const hasAbove = scrollOffset > 0;
					const hasBelow = scrollOffset + viewportHeight < allCardLines.length;
					const reservedTop = hasAbove ? 1 : 0;
					const reservedBottom = hasBelow ? 1 : 0;
					const contentHeight = viewportHeight - reservedTop - reservedBottom;
					const visibleLines = allCardLines.slice(scrollOffset, scrollOffset + contentHeight);

					if (hasAbove) output.push(theme.fg("dim", "  ▲ more above"));
					for (const line of visibleLines) output.push(line);
					if (hasBelow) output.push(theme.fg("dim", "  ▼ more below"));

					return output;
				}

				// ── Grid input ──

				function handleGridInput(data: string) {
					if (handleConfirmInput(data)) return;

					const numThreads = threadEntries.length;
					const numCols = Math.max(1, Math.min(getGridCols(lastRenderWidth), numThreads));
					const row = Math.floor(selectedIndex / numCols);
					const col = selectedIndex % numCols;
					const totalRows = Math.ceil(numThreads / numCols);

					if (matchesKey(data, Key.escape)) { closeOverlay(null); return; }

					if (matchesKey(data, Key.up) || data === "k") {
						if (row > 0) selectedIndex = Math.min((row - 1) * numCols + col, numThreads - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.down) || data === "j") {
						if (row < totalRows - 1) selectedIndex = Math.min((row + 1) * numCols + col, numThreads - 1);
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

					if (matchesKey(data, Key.pageUp)) {
						const vh = Math.max(1, (process.stdout.rows || 24) - 6);
						const scroll = Math.max(1, Math.floor(vh / 2));
						scrollOffset = Math.max(0, scrollOffset - scroll);
						if (row > 0) {
							const cardHeight = 7; // base card height from renderCard
							const newRow = Math.max(0, row - Math.max(1, Math.ceil(scroll / cardHeight)));
							selectedIndex = Math.min(newRow * numCols + col, numThreads - 1);
						}
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.pageDown)) {
						const vh = Math.max(1, (process.stdout.rows || 24) - 6);
						const scroll = Math.max(1, Math.floor(vh / 2));
						// Compute max scroll before adjusting
						const estimatedTotalLines = threadEntries.length * 9; // ~card height + gap
						const maxScroll = Math.max(0, estimatedTotalLines - vh);
						scrollOffset = Math.min(maxScroll, scrollOffset + scroll);
						if (row < totalRows - 1) {
							const cardHeight = 7; // base card height from renderCard
							const newRow = Math.min(totalRows - 1, row + Math.max(1, Math.ceil(scroll / cardHeight)));
							selectedIndex = Math.min(newRow * numCols + col, numThreads - 1);
						}
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						closeOverlay(getEntryAt(selectedIndex) ?? null);
						return;
					}

					if (data === "d") {
						if (pendingOperation) return;
						const threadName = getEntryAt(selectedIndex)?.threadName;
						if (!threadName) return;
						if (registry.runningThreads.has(threadName)) {
							ectx.ui.notify(`Thread "${threadName}" is currently busy`, "warning");
							return;
						}
						confirmMode = "delete";
						tui.requestRender();
						return;
					}
					if (data === "r") {
						if (pendingOperation) return;
						const threadName = getEntryAt(selectedIndex)?.threadName;
						if (!threadName) return;
						if (registry.runningThreads.has(threadName)) {
							ectx.ui.notify(`Thread "${threadName}" is currently busy`, "warning");
							return;
						}
						confirmMode = "reset";
						tui.requestRender();
						return;
					}

					if (data === "c") {
						if (pendingOperation) return;
						if (threadEntries.length === 0) return;
						confirmMode = "clear-all";
						tui.requestRender();
						return;
					}

					if (data === "\t") {
						view = "list";
						confirmMode = null;
						scrollOffset = 0;
						const preserveSessionPath = getEntryAt(selectedIndex)?.sessionPath;
						rebuildList(preserveSessionPath);
						syncSelectedIndexFromList();
						tui.requestRender();
						return;
					}
				}

				// ── List input (wraps SelectList but intercepts d/r/Tab) ──

				function handleListInput(data: string) {
					if (handleConfirmInput(data)) return;

					if (data === "c") {
						if (pendingOperation) return;
						if (threadEntries.length === 0) return;
						confirmMode = "clear-all";
						tui.requestRender();
						return;
					}

					// Tab → switch to grid
					if (data === "\t") {
						view = "grid";
						confirmMode = null;
						scrollOffset = 0;
						syncSelectedIndexFromList();
						tui.requestRender();
						return;
					}

					if (data === "d") {
						if (pendingOperation) return;
						syncSelectedIndexFromList();
						const threadName = getEntryAt(selectedIndex)?.threadName;
						if (!threadName) return;
						if (registry.runningThreads.has(threadName)) {
							ectx.ui.notify(`Thread "${threadName}" is currently busy`, "warning");
							return;
						}
						confirmMode = "delete";
						tui.requestRender();
						return;
					}

					if (data === "r") {
						if (pendingOperation) return;
						syncSelectedIndexFromList();
						const threadName = getEntryAt(selectedIndex)?.threadName;
						if (!threadName) return;
						if (registry.runningThreads.has(threadName)) {
							ectx.ui.notify(`Thread "${threadName}" is currently busy`, "warning");
							return;
						}
						confirmMode = "reset";
						tui.requestRender();
						return;
					}

					// Everything else goes to SelectList (arrows, enter, esc, search, etc.)
					selectList.handleInput(data);
					tui.requestRender();
				}

				// ── Main render/input router ──

				return {
					render(width: number): string[] {
						lastRenderWidth = width;
						const output: string[] = [];

						// Title bar
						const viewLabel = view === "list" ? "List" : "Grid";
						const title = `🧵 Thread Manager  [${viewLabel}]`;
						output.push(theme.fg("accent", theme.bold(centerText(title, width))));

						const helpParts = [
							"Tab=switch view",
							"d=delete",
							"r=reset",
							"c=clear all",
							"Enter=episodes",
							"Esc=close",
						];
						output.push(theme.fg("dim", centerText(helpParts.join("  "), width)));
						output.push("");

						if (view === "list") {
							// Render the SelectList inside a container
							const listContainer = new Container();
							listContainer.addChild(selectList);
							const listLines = listContainer.render(width);
							for (const line of listLines) output.push(line);

							// Inline confirmation prompt
							if (confirmMode) {
								const verb = confirmMode === "clear-all" ? "Clear ALL threads" : confirmMode === "delete" ? "Delete" : "Reset";
								const threadName = confirmMode === "clear-all" ? `${threadEntries.length} threads` : (getEntryAt(selectedIndex)?.threadName ?? "");
								output.push("");
								output.push(theme.fg("warning", centerText(`${verb} "${threadName}"? (y/n)`, width)));
							}
						} else {
							const gridLines = renderGrid(width);
							for (const line of gridLines) output.push(line);
						}

						return output;
					},

					invalidate() {
						// Rebuild themed state on theme changes
						selectItems = buildSelectItems();
						selectList = buildSelectList();
						if (selectItems.length > 0) {
							selectList.setSelectedIndex(Math.min(selectedIndex, selectItems.length - 1));
						}
					},

					handleInput(data: string) {
						if (view === "list") {
							handleListInput(data);
						} else {
							handleGridInput(data);
						}
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "80%",
					minWidth: 40,
					maxHeight: "80%",
				},
			},
		);

		// If a thread was selected, open episode sidebar
		if (result) {
			await openEpisodeSidebar(ectx, result.threadName, ectx.cwd, registry.sessionId, result.sessionPath);
		}
	};

	// ── Register shortcuts & command ──

	// Shortcuts
	pi.registerShortcut("ctrl+alt+t", {
		description: "Open Thread Manager",
		handler: openManager,
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open Thread Manager",
		handler: openManager,
	});

	// Commands
	pi.registerCommand("threads", {
		description: "Open the Thread Manager",
		handler: async (_args, ectx) => openManager(ectx),
	});

	pi.registerCommand("thread-delete", {
		description: "Open the Thread Manager (delete threads from there)",
		handler: async (_args, ectx) => openManager(ectx),
	});
}
