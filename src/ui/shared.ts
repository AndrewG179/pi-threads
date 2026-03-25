import type { ThreadRegistry } from "../state.ts";

interface ThemeWithFg {
	fg: (color: string, text: string) => string;
}

/** Compute the status icon for a thread. Shared by dashboard and widget. */
export function getStatusIcon(
	registry: ThreadRegistry,
	name: string,
	theme: ThemeWithFg,
): string {
	if (registry.threadErrors.get(name) === true) return theme.fg("error", "✗");
	if (registry.runningThreads.has(name)) return theme.fg("warning", "◉");
	if ((registry.episodeCounts.get(name) || 0) > 0) return theme.fg("success", "●");
	return theme.fg("dim", "○");
}
