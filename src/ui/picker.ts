/**
 * Thread Picker — Ctrl+Alt+T overlay
 *
 * Shows all threads with episode count, context tokens, and last activity.
 * Enter opens the Episode Sidebar for the selected thread.
 */

import * as fs from "node:fs";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

import type { ThreadRegistry } from "../state.ts";
import { listThreads, getThreadSessionPath, formatTokens, relativeTime } from "../helpers.ts";
import { openEpisodeSidebar } from "./sidebar.ts";

export function setupPicker(pi: ExtensionAPI, registry: ThreadRegistry): void {
	pi.registerShortcut("ctrl+alt+t", {
		description: "Open thread picker",
		handler: async (ctx) => {
			const threads = listThreads(ctx.cwd);
			if (threads.length === 0) {
				ctx.ui.notify("No threads yet", "info");
				return;
			}

			// Build items with metadata
			const items: SelectItem[] = threads.map((t) => {
				const count = registry.episodeCounts.get(t) || 0;
				const stats = registry.threadStats.get(t);
				const sessionPath = getThreadSessionPath(ctx.cwd, t);

				let mtimeStr = "";
				try {
					const stat = fs.statSync(sessionPath);
					mtimeStr = relativeTime(stat.mtimeMs);
				} catch { /* ignore */ }

				const contextInfo = stats?.contextTokens ? `${formatTokens(stats.contextTokens)} ctx` : "0 ctx";
				const description = `${count} ep · ${contextInfo} · ${mtimeStr || "unknown"}`;

				return {
					value: t,
					label: t,
					description,
				};
			});

			const result = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					const container = new Container();

					// Top border
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					// Title
					container.addChild(new Text(theme.fg("accent", theme.bold("🧵 Thread Picker")), 1, 0));
					container.addChild(
						new Text(theme.fg("muted", `  ${threads.length} thread${threads.length !== 1 ? "s" : ""}`), 0, 0),
					);

					// SelectList
					const selectList = new SelectList(items, Math.min(items.length, 12), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});

					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(null);

					container.addChild(selectList);

					// Help text
					container.addChild(
						new Text(theme.fg("dim", "  ↑↓ navigate · enter open episodes · esc cancel"), 1, 0),
					);

					// Bottom border
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "60%",
						minWidth: 40,
						maxHeight: "80%",
					},
				},
			);

			if (result) {
				openEpisodeSidebar(ctx, result, ctx.cwd);
			}
		},
	});
}
