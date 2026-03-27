import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { UsageStats } from "./types.ts";

// ─── Constants ───

export const THREADS_DIR = ".pi/threads";
export const MAX_CONCURRENCY = 4;
export const MAX_COLUMNS = 3;

// ─── Path Helpers ───

export function getThreadsDir(cwd: string, sessionId: string): string {
	if (!sessionId) throw new Error("sessionId is required for thread directory resolution");
	const safe = sessionId.replace(/[^\w.-]+/g, "_");
	if (safe === "." || safe === "..") throw new Error(`Invalid sessionId: "${sessionId}"`);
	return path.join(cwd, THREADS_DIR, safe);
}

export function getThreadSessionPath(cwd: string, sessionId: string, threadName: string): string {
	const safe = threadName.replace(/[^\w.-]+/g, "_").slice(0, 40);
	if (safe === "." || safe === "..") throw new Error(`Invalid thread name: "${threadName}"`);
	const hash = crypto.createHash("sha256").update(threadName).digest("hex").slice(0, 8);
	return path.join(getThreadsDir(cwd, sessionId), `${safe}_${hash}.jsonl`);
}

export async function listThreads(cwd: string, sessionId: string): Promise<string[]> {
	const sessions = await listThreadSessions(cwd, sessionId);
	return sessions.map((session) => session.threadName);
}

export interface ThreadSessionInfo {
	threadName: string;
	sessionPath: string;
}

export function getThreadNameIndexPath(cwd: string, sessionId: string): string {
	return path.join(getThreadsDir(cwd, sessionId), "thread-names.json");
}

export async function readThreadNameIndex(cwd: string, sessionId: string): Promise<Record<string, string>> {
	if (!sessionId) return {};
	const indexPath = getThreadNameIndexPath(cwd, sessionId);
	try {
		const contents = await fs.promises.readFile(indexPath, "utf-8");
		const parsed: unknown = JSON.parse(contents);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const index: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "string") index[key] = value;
		}
		return index;
	} catch {
		return {};
	}
}

export async function writeThreadNameIndex(cwd: string, sessionId: string, index: Record<string, string>): Promise<void> {
	if (!sessionId) return;
	await ensureThreadsDir(cwd, sessionId);
	const indexPath = getThreadNameIndexPath(cwd, sessionId);
	await fs.promises.writeFile(indexPath, JSON.stringify(index, null, "\t"), "utf-8");
}

export async function recordThreadName(cwd: string, sessionId: string, threadName: string): Promise<void> {
	if (!sessionId) return;
	const sessionFileName = path.basename(getThreadSessionPath(cwd, sessionId, threadName));
	const index = await readThreadNameIndex(cwd, sessionId);
	if (index[sessionFileName] === threadName) return;
	index[sessionFileName] = threadName;
	await writeThreadNameIndex(cwd, sessionId, index);
}

export async function removeThreadName(cwd: string, sessionId: string, threadName: string): Promise<void> {
	if (!sessionId) return;
	const sessionFileName = path.basename(getThreadSessionPath(cwd, sessionId, threadName));
	const index = await readThreadNameIndex(cwd, sessionId);
	if (!(sessionFileName in index)) return;
	delete index[sessionFileName];
	await writeThreadNameIndex(cwd, sessionId, index);
}

export async function listThreadSessions(cwd: string, sessionId: string): Promise<ThreadSessionInfo[]> {
	if (!sessionId) return [];
	const dir = getThreadsDir(cwd, sessionId);
	const exists = await fs.promises.access(dir).then(() => true).catch(() => false);
	if (!exists) return [];
	const index = await readThreadNameIndex(cwd, sessionId);
	try {
		const files = await fs.promises.readdir(dir);
		return files
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({
				threadName: index[f] || f.replace(/\.jsonl$/, ""),
				sessionPath: path.join(dir, f),
			}));
	} catch {
		return [];
	}
}

export async function ensureThreadsDir(cwd: string, sessionId: string): Promise<string> {
	const dir = getThreadsDir(cwd, sessionId);
	await fs.promises.mkdir(dir, { recursive: true });
	return dir;
}

// ─── Temp File Helpers ───

export async function writeTempFile(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-thread-${prefix}-`));
	const filePath = path.join(tmpDir, `${prefix}.md`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export async function cleanupTemp(dir: string | null, file: string | null): Promise<void> {
	if (file)
		try {
			await fs.promises.unlink(file);
		} catch (e: any) {
			if (e?.code !== 'ENOENT') {
				// Log non-ENOENT errors for debugging
				console.error('Cleanup error:', e?.message);
			}
		}
	if (dir)
		try {
			await fs.promises.rm(dir, { recursive: true });
		} catch (e: any) {
			if (e?.code !== 'ENOENT') {
				// Log non-ENOENT errors for debugging
				console.error('Cleanup error:', e?.message);
			}
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
	const errors: { index: number; error: unknown }[] = [];
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			// Safe: JS is single-threaded, so nextIndex++ is atomic.
			// Each worker awaits fn() which may yield, but the increment
			// and bounds check happen synchronously before the await.
			const current = nextIndex++;
			if (current >= items.length) return;
			try {
				results[current] = await fn(items[current], current);
			} catch (error) {
				errors.push({ index: current, error });
			}
		}
	});
	await Promise.all(workers);
	if (errors.length > 0) {
		if (errors.length === 1) {
			throw errors[0].error;
		}
		throw new AggregateError(
			errors.map((e) => e.error),
			`${errors.length} of ${items.length} tasks failed`,
		);
	}
	return results;
}

// ─── Pi Invocation ───

export async function getPiInvocation(args: string[]): Promise<{ command: string; args: string[] }> {
	// Branch 1: Running via `node /path/to/pi.js` — re-invoke with same script
	const currentScript = process.argv[1];
	if (currentScript) {
		const scriptExists = await fs.promises.access(currentScript).then(() => true).catch(() => false);
		if (scriptExists) {
			return { command: process.execPath, args: [currentScript, ...args] };
		}
	}
	// Branch 2: Running as a compiled binary (e.g. `pi` installed as native executable)
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	// Branch 3: Fallback — assume `pi` is available on PATH
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
				output.push(...item(width).map((l) => truncateToWidth(l, width)));
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
				const padded = truncatePreserveBg(line, colWidth);
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
	return wrapTextWithAnsi(text, width);
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
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
export { truncateToWidth, visibleWidth };

/**
 * Wrap truncateToWidth so that the full ANSI reset (\x1b[0m) it injects is
 * replaced with a selective reset that preserves background colour.
 *
 * truncateToWidth's finalizeTruncatedResult always emits \x1b[0m around the
 * ellipsis. That kills any background set by a parent Box/container, leaving
 * a visible "hole" to the right of the "...".  We swap in SGR codes that
 * reset intensity, italic, underline, strike-through and fg colour — but NOT
 * background (49) — so the Box bg survives.
 */
export function truncatePreserveBg(text: string, maxWidth: number, ellipsis = "..."): string {
	const result = truncateToWidth(text, maxWidth, ellipsis);
	return result.replaceAll('\x1b[0m', '\x1b[22;23;24;29;39m');
}
