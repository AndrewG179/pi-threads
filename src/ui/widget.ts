import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThreadRegistry } from "../state.ts";
import { getStatusIcon } from "./shared.ts";
import { listThreads, formatTokens, relativeTime, truncateToWidth } from "../helpers.ts";

// ─── Widget Setup ───

export function setupWidget(registry: ThreadRegistry, ctx: ExtensionContext): () => void {
	const cwd = ctx.cwd;

	function rebuildWidget(): void {
		const threads = listThreads(cwd, registry.sessionId);

		if (threads.length === 0) {
			ctx.ui.setWidget("pi-threads", undefined);
			return;
		}

		ctx.ui.setWidget("pi-threads", (_tui, theme) => {
			// Build themed lines once when the factory is called
			const lines: string[] = [];
			lines.push(theme.fg("accent", "🧵 Threads"));

			for (const name of threads) {
				const episodes = registry.episodeCounts.get(name) || 0;
				const stats = registry.threadStats.get(name);
				const lastActive = registry.lastActivity.get(name);

				// Status icon
				const icon = getStatusIcon(registry, name, theme);

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

	// Debounce re-renders on registry changes to avoid excessive synchronous I/O.
	// During batch dispatch, registry emits 8-10 changes per thread; this collapses
	// them into a single rebuild after activity settles.
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	const unsubscribe = registry.onChange(() => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			rebuildWidget();
			debounceTimer = null;
		}, 100);
	});

	return () => {
		unsubscribe();
		if (debounceTimer) clearTimeout(debounceTimer);
	};
}
