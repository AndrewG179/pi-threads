import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { UsageStats } from "./types.ts";

// ─── Constants ───

export const THREADS_DIR = ".pi/threads";
export const MAX_CONCURRENCY = 4;
export const MAX_COLUMNS = 3;

// ─── Path Helpers ───

export function getThreadsDir(cwd: string): string {
	return path.join(cwd, THREADS_DIR);
}

export function getThreadSessionPath(cwd: string, threadName: string): string {
	const safe = threadName.replace(/[^\w.-]+/g, "_");
	return path.join(getThreadsDir(cwd), `${safe}.jsonl`);
}

export function listThreads(cwd: string): string[] {
	const dir = getThreadsDir(cwd);
	if (!fs.existsSync(dir)) return [];
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.replace(/\.jsonl$/, ""));
	} catch {
		return [];
	}
}

export function ensureThreadsDir(cwd: string): void {
	const dir = getThreadsDir(cwd);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

// ─── Temp File Helpers ───

export function writeTempFile(prefix: string, content: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-thread-${prefix}-`));
	const filePath = path.join(tmpDir, `${prefix}.md`);
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export function cleanupTemp(dir: string | null, file: string | null): void {
	if (file)
		try {
			fs.unlinkSync(file);
		} catch {
			/* ignore */
		}
	if (dir)
		try {
			fs.rmdirSync(dir);
		} catch {
			/* ignore */
		}
}

// ─── Concurrency ───

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			// Safe: JS is single-threaded, so nextIndex++ is atomic.
			// Each worker awaits fn() which may yield, but the increment
			// and bounds check happen synchronously before the await.
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ─── Pi Invocation ───

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

// ─── Formatting ───

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Render items in rows of up to MAX_COLUMNS columns.
 * Each item is a function that takes column width and returns rendered lines.
 */
export function renderColumnsInRows(
	items: ((colWidth: number) => string[])[],
	width: number,
	theme: { fg: (style: string, text: string) => string },
): string[] {
	const sep = theme.fg("muted", "│");
	const sepWidth = 3; // " │ "
	const output: string[] = [];

	for (let rowStart = 0; rowStart < items.length; rowStart += MAX_COLUMNS) {
		const rowItems = items.slice(rowStart, rowStart + MAX_COLUMNS);
		const numCols = rowItems.length;
		const colWidth = Math.floor((width - sepWidth * (numCols - 1)) / numCols);

		if (colWidth < 20) {
			// Too narrow — stack vertically
			for (const item of rowItems) {
				output.push(...item(width));
				output.push("");
			}
			continue;
		}

		// Render each column
		const columns: string[][] = rowItems.map((item) => item(colWidth));

		// Pad to same height with full-width spaces (so background fills)
		const maxHeight = Math.max(...columns.map((c) => c.length));
		for (const col of columns) {
			while (col.length < maxHeight) col.push(" ".repeat(colWidth));
		}

		// Zip lines
		for (let row = 0; row < maxHeight; row++) {
			const parts: string[] = [];
			for (let c = 0; c < numCols; c++) {
				const line = columns[c][row];
				const padded = truncateToWidth(line, colWidth);
				const pad = colWidth - visibleWidth(padded);
				parts.push(padded + " ".repeat(Math.max(0, pad)));
			}
			output.push(parts.join(` ${sep} `));
		}

		// Add spacing between rows of columns
		if (rowStart + MAX_COLUMNS < items.length) {
			output.push(" ".repeat(width));
		}
	}

	return output;
}

export function wrapText(text: string | undefined, width: number): string[] {
	if (!text) return [""];
	if (width < 10) return [text];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (!paragraph.trim()) {
			lines.push("");
			continue;
		}
		const words = paragraph.split(/\s+/);
		let current = "";
		for (const word of words) {
			if (current.length + word.length + 1 > width && current.length > 0) {
				lines.push(current);
				current = word;
			} else {
				current = current ? current + " " + word : word;
			}
		}
		if (current) lines.push(current);
	}
	return lines.length > 0 ? lines : [""];
}

export function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

// ─── Relative Time ───

export function relativeTime(ts: number): string {
	const elapsed = Date.now() - ts;
	if (elapsed < 60_000) return "just now";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
	if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
	return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

// Re-export TUI utilities used by renderColumnsInRows
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
export { truncateToWidth, visibleWidth };
