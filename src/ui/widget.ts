import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThreadRegistry } from "../state.ts";
import { listThreads, formatTokens, relativeTime, truncateToWidth } from "../helpers.ts";

// ─── Widget Setup ───

export function setupWidget(registry: ThreadRegistry, ctx: ExtensionContext): void {
	const cwd = ctx.cwd;

	function rebuildWidget(): void {
		const threads = listThreads(cwd);

		if (threads.length === 0) {
			ctx.ui.setWidget("pi-threads", undefined);
			return;
		}

		ctx.ui.setWidget("pi-threads", (_tui, theme) => {
			// Build themed lines once when the factory is called
			const lines: string[] = [];
			lines.push(theme.fg("accent", "🧵 Threads"));

			for (const name of threads) {
				const isRunning = registry.runningThreads.has(name);
				const hasError = registry.threadErrors.get(name) === true;
				const episodes = registry.episodeCounts.get(name) || 0;
				const stats = registry.threadStats.get(name);
				const lastActive = registry.lastActivity.get(name);

				// Status icon
				let icon: string;
				if (hasError) {
					icon = theme.fg("error", "✗");
				} else if (isRunning) {
					icon = theme.fg("warning", "◉");
				} else if (episodes > 0) {
					icon = theme.fg("success", "●");
				} else {
					icon = theme.fg("dim", "○");
				}

				// Thread name
				const nameStr = theme.fg("accent", name);

				// Episode count
				const epStr = theme.fg("muted", `${episodes} episode${episodes !== 1 ? "s" : ""}`);

				// Context tokens
				const ctxStr = stats?.contextTokens
					? theme.fg("muted", `${formatTokens(stats.contextTokens)} ctx`)
					: "";

				// Relative time
				const timeStr = lastActive
					? theme.fg("muted", relativeTime(lastActive))
					: "";

				// Build line: icon name  episodes  ctx  time
				const parts = [icon, nameStr, epStr];
				if (ctxStr) parts.push(ctxStr);
				if (timeStr) parts.push(timeStr);

				lines.push("  " + parts.join("  "));
			}

			return {
				render: (width: number) => lines.map((line) => truncateToWidth(line, width)),
				invalidate: () => {},
			};
		});
	}

	// Initial render
	rebuildWidget();

	// Re-render on registry changes (triggers filesystem I/O + themed line rebuild)
	registry.onChange(() => {
		rebuildWidget();
	});
}
