/**
 * Threads — orchestrator-driven execution model
 *
 * The main agent is a strategic orchestrator. It never touches files or runs
 * commands. Instead, it dispatches concrete actions to threads.
 *
 * A thread is a persistent pi session that accumulates context across actions.
 * Each action generates an episode — a compressed representation of what
 * happened — that flows back to the orchestrator.
 *
 * Threads follow instructions precisely. They handle tactical details (missing
 * imports, typos, small errors) but never make strategic decisions. If something
 * fails outside their scope, they stop and report back.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Constants ───

const THREADS_DIR = ".pi/threads";

const THREAD_WORKER_PROMPT = `You are a thread — an execution worker controlled by an orchestrator.

## Your Role
Execute the instructions given to you. You are the hands, not the brain.

## Rules
1. **Follow instructions precisely.** Do exactly what you're told.
2. **Handle tactical details.** Missing imports, typos, small fixups needed to complete your task — just handle them.
3. **Never make strategic decisions.** If something is ambiguous, if you face a fork where different approaches are possible, or if you encounter something unexpected — STOP and report back. Do not guess.
4. **If you fail, report clearly.** Don't try alternative approaches. Describe what went wrong and what state things are in now.
5. **Be thorough within scope.** Complete all parts of your instructions.`;



const ORCHESTRATOR_PROMPT = `
# Thread-Based Execution Model

You are a **strategic orchestrator**. You think, plan, and decide. You never execute.

## How You Work
- You have one tool: \`dispatch\`. It sends an action to a thread and returns an episode (compressed result).
- A **thread** is a persistent worker with its own context. It accumulates knowledge across actions.
- Use **named threads** to organize work streams (e.g., "auth-refactor", "test-suite", "deploy").

## Rules
1. **Never use file or shell tools.** You only dispatch.
2. **Give concrete, direct instructions.** Not "figure out the auth system" but "Read src/auth/middleware.ts and list all exported functions with their signatures."
3. **One logical action per dispatch.** A dispatch can involve multiple steps ("SSH in, check the config, update it") but they should serve one coherent goal.
4. **React to episodes.** Episodes are adaptive — investigation tasks return findings, edit tasks return what changed, test tasks return results. Use the information to plan your next move.
5. **Reuse threads for related work.** Thread "auth-refactor" should handle all auth-related actions — it builds up context about that area.
6. **Create new threads for independent work streams.** Don't mix unrelated work in one thread.
7. **If a thread fails, you adapt.** Re-plan, give different instructions, or try a different approach. The thread just reports — you decide.
8. **Shape the episode with your action.** The more specific your instructions, the more useful the episode. If you need specific information back, say so in the action (e.g., "...and list each endpoint with its HTTP method and handler function name").
9. **Never ask for raw dumps.** The thread's response comes back into YOUR context. Never ask a thread to "show me the complete contents" of a file or "paste the full output." Instead, ask for what you actually need: "Read X and summarize its structure", "Read X and list the key sections", "Run Y and tell me if it passed or what the error was." Your context is precious — don't fill it with raw file contents or unfiltered command output.

## Thinking Levels
- Each dispatch can set a thinking level: off, minimal, low, medium, high, xhigh
- Use "off" for simple reads, file listings, running commands, grep searches
- Use "minimal" or "low" for straightforward edits, simple fixes
- Use "medium" for bug fixes, moderate changes, debugging
- Use "high" for complex implementations, architecture changes, multi-file refactors
- Use "xhigh" for the hardest problems (only works on Opus 4.6 / GPT-5.x, clamped to high on other models)
- If not specified, uses the global subagent thinking level

## Dispatch Examples

Good — with appropriate thinking levels:
- \`dispatch(thread: "backend", action: "Read src/api/routes.ts and list every route with its HTTP method, path, and handler function name", thinking: "off")\`
- \`dispatch(thread: "debug", action: "Run pytest -x and tell me if it passes. If it fails, show the first failure's test name, assertion, and traceback", thinking: "off")\`
- \`dispatch(thread: "worker", action: "Implement JWT refresh token rotation with secure cookie storage", thinking: "high")\`

Bad — dumps raw content into your context:
- ~~\`dispatch(thread: "x", action: "Show me the complete contents of README.md")\`~~
- ~~\`dispatch(thread: "x", action: "Run find . -type f and paste the output")\`~~

Batch (parallel, with mixed thinking levels):
- \`dispatch(tasks: [{thread: "scout", action: "Find all auth-related files and list them", thinking: "off"}, {thread: "worker", action: "Refactor auth middleware to use RBAC pattern", thinking: "high"}, {thread: "tests", action: "Run the test suite and report pass/fail counts", thinking: "off"}])\`
`;

// ─── Types ───

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface ThreadStats {
	contextTokens: number;
	lastCompactedAt: number;
	compactionCount: number;
}

interface ThreadActionResult {
	thread: string;
	action: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sessionPath: string;
	isNewThread: boolean;
	compaction?: { tokensBefore: number; tokensAfter: number };
}

interface SingleDispatchResult {
	thread: string;
	action: string;
	episode: string;
	episodeNumber: number;
	result: ThreadActionResult;
}

interface DispatchDetails {
	mode: "single" | "batch";
	items: SingleDispatchResult[];
}

// ─── Helpers ───

function getThreadsDir(cwd: string): string {
	return path.join(cwd, THREADS_DIR);
}

function getThreadSessionPath(cwd: string, threadName: string): string {
	const safe = threadName.replace(/[^\w.-]+/g, "_");
	return path.join(getThreadsDir(cwd), `${safe}.jsonl`);
}

function listThreads(cwd: string): string[] {
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

function ensureThreadsDir(cwd: string): void {
	const dir = getThreadsDir(cwd);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function writeTempFile(prefix: string, content: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-thread-${prefix}-`));
	const filePath = path.join(tmpDir, `${prefix}.md`);
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function cleanupTemp(dir: string | null, file: string | null): void {
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


function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

const MAX_COLUMNS = 3;

/**
 * Render items in rows of up to MAX_COLUMNS columns.
 * Each item is a function that takes column width and returns rendered lines.
 */
function renderColumnsInRows(
	items: ((colWidth: number) => string[])[],
	width: number,
	theme: any,
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

function wrapText(text: string | undefined, width: number): string[] {
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

function formatUsage(usage: UsageStats, model?: string): string {
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

// ─── Thread Execution ───

/**
 * Run a pi process against a thread session. Used for both the action
 * and the episode extraction (same session = cached context).
 */
async function runPiOnThread(
	cwd: string,
	sessionPath: string,
	message: string,
	model: string | undefined,
	thinking: string | undefined,
	systemPromptFile: string | undefined,
	signal: AbortSignal | undefined,
	onMessage?: (msg: Message) => void,
): Promise<{ exitCode: number; messages: Message[]; stderr: string; compaction?: { tokensBefore: number; tokensAfter: number } }> {
	const args: string[] = ["--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates"];
	args.push("--session", sessionPath);
	if (model) {
		args.push("--model", model);
	}
	if (thinking) {
		args.push("--thinking", thinking);
	}
	if (systemPromptFile) args.push("--append-system-prompt", systemPromptFile);
	args.push(message);

	const messages: Message[] = [];
	let stderr = "";
	let wasAborted = false;
	let compactionResult: { tokensBefore: number; tokensAfter: number } | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				messages.push(event.message as Message);
				onMessage?.(event.message as Message);
			}
			if (event.type === "tool_result_end" && event.message) {
				messages.push(event.message as Message);
				onMessage?.(event.message as Message);
			}
			if (event.type === "auto_compaction_end" && event.result) {
				compactionResult = {
					tokensBefore: event.result.tokensBefore ?? 0,
					tokensAfter: event.result.tokensAfter ?? 0,
				};
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code: number | null) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", () => resolve(1));

		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});

	if (wasAborted) throw new Error("Thread was aborted");
	return { exitCode, messages, stderr, compaction: compactionResult };
}

async function runThreadAction(
	cwd: string,
	threadName: string,
	action: string,
	model: string | undefined,
	thinking: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<DispatchDetails>) => void) | undefined,
	episodeNumber: number,
): Promise<ThreadActionResult> {
	ensureThreadsDir(cwd);
	const sessionPath = getThreadSessionPath(cwd, threadName);
	const isNewThread = !fs.existsSync(sessionPath);

	const result: ThreadActionResult = {
		thread: threadName,
		action,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		sessionPath,
		isNewThread,
	};

	const trackUsage = (msg: Message) => {
		if (msg.role === "assistant") {
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!result.model && msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
		}
	};

	const emitUpdate = () => {
		if (onUpdate) {
			const lastText = getFinalOutput(result.messages);
			onUpdate({
				content: [{ type: "text", text: lastText || "(running...)" }],
				details: {
					mode: "single",
					items: [{
						thread: threadName,
						action,
						episode: "(running...)",
						episodeNumber,
						result,
					}],
				},
			});
		}
	};

	// Write thread worker prompt to temp file
	const promptTmp = writeTempFile("worker", THREAD_WORKER_PROMPT);

	try {
		// Single process: thread executes the action AND produces the episode
		// inline (delimited by ---EPISODE--- markers). No second process needed.
		const actionResult = await runPiOnThread(
			cwd,
			sessionPath,
			action,
			model,
			thinking,
			promptTmp.filePath,
			signal,
			(msg) => {
				result.messages.push(msg);
				trackUsage(msg);
				emitUpdate();
			},
		);
		result.exitCode = actionResult.exitCode;
		result.stderr = actionResult.stderr;
		result.compaction = actionResult.compaction;

		return result;
	} finally {
		cleanupTemp(promptTmp.dir, promptTmp.filePath);
	}
}

// ─── Episode Generation ───

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Build a transcript from thread messages for the episode generator.
 * Includes tool calls AND their results so the episode has actual data.
 */
/**
 * Build the episode directly from thread output — no extra model call.
 * Returns: tool call history + last assistant message.
 * The orchestrator sees exactly what the thread did and said.
 */
function buildEpisode(messages: Message[], compaction?: { tokensBefore: number; tokensAfter: number }): string {
	const parts: string[] = [];
	if (compaction) {
		parts.push(`⚠️ Context was compacted during this action (${formatTokens(compaction.tokensBefore)} → ${formatTokens(compaction.tokensAfter)} tokens kept)\n`);
	}

	// Part 1: Tool call history — compact summary of what the thread did
	const toolCalls: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall") {
				const args = part.arguments as Record<string, unknown>;
				switch (part.name) {
					case "bash": {
						const cmd = ((args.command as string) || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
						const preview = cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
						toolCalls.push(`$ ${preview}`);
						break;
					}
					case "read": {
						const p = (args.file_path || args.path || "") as string;
						const offset = args.offset as number | undefined;
						const limit = args.limit as number | undefined;
						let entry = `read ${p}`;
						if (offset || limit) entry += `:${offset || 1}${limit ? `-${(offset || 1) + limit - 1}` : ""}`;
						toolCalls.push(entry);
						break;
					}
					case "write": {
						const p = (args.file_path || args.path || "") as string;
						const content = (args.content || "") as string;
						const lines = content.split("\n").length;
						toolCalls.push(`write ${p} (${lines} lines)`);
						break;
					}
					case "edit": {
						const p = (args.file_path || args.path || "") as string;
						toolCalls.push(`edit ${p}`);
						break;
					}
					default: {
						const s = JSON.stringify(args);
						toolCalls.push(`${part.name} ${s.length > 80 ? s.slice(0, 80) + "..." : s}`);
					}
				}
			}
		}
	}

	if (toolCalls.length > 0) {
		parts.push("TOOL CALLS:");
		for (const tc of toolCalls) {
			parts.push(`  ${tc}`);
		}
		parts.push("");
	}

	// Part 2: Last assistant message — the thread's final response
	const lastMessage = getFinalOutput(messages);
	if (lastMessage.trim()) {
		parts.push("THREAD RESPONSE:");
		parts.push(lastMessage);
	}

	return parts.join("\n") || "(no output)";
}


// ─── Rendering Helpers ───

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: any, text: string) => string,
): string {
	const shorten = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (toolName) {
		case "bash": {
			const cmd = ((args.command as string) || "...").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
			const preview = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
			return fg("muted", "$ ") + fg("toolOutput", preview);
		}
		case "read": {
			const filePath = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "read ") + fg("accent", filePath);
		}
		case "write": {
			const filePath = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "write ") + fg("accent", filePath);
		}
		case "edit": {
			const filePath = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "edit ") + fg("accent", filePath);
		}
		default: {
			const s = JSON.stringify(args);
			return fg("accent", toolName) + fg("dim", ` ${s.length > 60 ? s.slice(0, 60) + "..." : s}`);
		}
	}
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

// ─── Extension ───

export default function (pi: ExtensionAPI) {
	// Track episode counts per thread (reconstructed from session)
	const episodeCounts = new Map<string, number>();
	const threadStats = new Map<string, ThreadStats>();
	let subagentModel = "anthropic/claude-sonnet-4-6";
	let subagentThinking: string | undefined = undefined;

	const updateStatusBar = (ctx: any) => {
		const thinkingLabel = subagentThinking || "default";
		const statusText = `sub: ${subagentModel} | thinking: ${thinkingLabel}`;
		ctx.ui.setStatus("subagent-model", `\x1b[${(process.stdout.columns ?? 120) - statusText.length + 1}G\x1b[2m${statusText}\x1b[0m`);
	};

	pi.registerCommand("model-sub", {
		description: "Set the subagent model for thread workers (supports :thinking suffix, e.g. sonnet:high)",
		handler: async (args, ctx) => {
			const input = args.trim();

			// Direct match via argument (like /model <term>)
			if (input) {
				// Parse optional :thinking suffix (e.g., "sonnet:high", "anthropic/claude-sonnet-4-5:medium")
				let modelInput = input;
				let thinkingSuffix: string | undefined;
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
				const lastColon = input.lastIndexOf(":");
				if (lastColon > 0) {
					const suffix = input.substring(lastColon + 1).toLowerCase();
					if (levels.includes(suffix)) {
						modelInput = input.substring(0, lastColon);
						thinkingSuffix = suffix;
					}
				}

				const slashIndex = modelInput.indexOf("/");
				if (slashIndex > 0) {
					const provider = modelInput.substring(0, slashIndex);
					const modelId = modelInput.substring(slashIndex + 1);
					const found = ctx.modelRegistry.find(provider, modelId);
					if (found) {
						subagentModel = `${provider}/${modelId}`;
						if (thinkingSuffix) subagentThinking = thinkingSuffix;
						updateStatusBar(ctx);
						const thinkingMsg = thinkingSuffix ? ` | thinking: ${thinkingSuffix}` : "";
						ctx.ui.notify(`Subagent model set to: ${subagentModel}${thinkingMsg}`, "info");
						return;
					}
				}
				// Fuzzy match
				const allModels = ctx.modelRegistry.getAvailable();
				const matches = allModels.filter((m: any) =>
					`${m.id} ${m.provider} ${m.provider}/${m.id}`.toLowerCase().includes(modelInput.toLowerCase())
				);
				if (matches.length === 1) {
					subagentModel = `${matches[0].provider}/${matches[0].id}`;
					if (thinkingSuffix) subagentThinking = thinkingSuffix;
					updateStatusBar(ctx);
					const thinkingMsg = thinkingSuffix ? ` | thinking: ${thinkingSuffix}` : "";
					ctx.ui.notify(`Subagent model set to: ${subagentModel}${thinkingMsg}`, "info");
					return;
				}
				// Fall through to picker with search pre-filled
			}

			// Show interactive picker (mirrors /model UI)
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models available", "error");
				return;
			}

			// Sort: current model first, then alphabetical by provider
			const items = available
				.map((m: any) => ({
					id: m.id,
					name: m.name || m.id,
					provider: m.provider,
					isCurrent: `${m.provider}/${m.id}` === subagentModel,
				}))
				.sort((a: any, b: any) => {
					if (a.isCurrent && !b.isCurrent) return -1;
					if (!a.isCurrent && b.isCurrent) return 1;
					return a.provider.localeCompare(b.provider);
				});

			const { DynamicBorder } = await import("@mariozechner/pi-coding-agent");
			const { Container, Text, Input, matchesKey, Key } = await import("@mariozechner/pi-tui");

			const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const maxVisible = 10;
				let selectedIndex = 0;
				let filtered = [...items];
				let searchText = input || "";

				// Apply initial search if provided
				if (searchText) {
					applyFilter();
				}

				function applyFilter() {
					const q = searchText.toLowerCase();
					if (!q) {
						filtered = [...items];
					} else {
						filtered = items.filter((m: any) =>
							`${m.id} ${m.provider} ${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q)
						);
					}
					selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
				}

				const container = new Container();

				const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(topBorder);

				const headerText = new Text(theme.fg("muted", "  Only showing models with configured API keys. Configure keys in settings or environment."), 0, 1);
				container.addChild(headerText);

				const searchInput = new Input(
					(s: string) => theme.fg("text", s),
					(s: string) => theme.fg("accent", s),
					80,
					"Search models..."
				);
				if (searchText) {
					// Pre-fill search
					for (const ch of searchText) {
						searchInput.handleInput(ch);
					}
				}
				container.addChild(searchInput);

				// Spacer
				container.addChild(new Text("", 0, 1));

				// Model list (rendered dynamically)
				const listText = new Text("", 0, 0);
				container.addChild(listText);

				// Detail line
				const detailText = new Text("", 0, 1);
				container.addChild(detailText);

				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(bottomBorder);

				function renderList() {
					if (filtered.length === 0) {
						listText.text = theme.fg("warning", "  No matching models");
						detailText.text = "";
						return;
					}

					// Scroll window centred on selectedIndex
					let startIndex = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
					if (startIndex + maxVisible > filtered.length) {
						startIndex = Math.max(0, filtered.length - maxVisible);
					}
					const endIndex = Math.min(startIndex + maxVisible, filtered.length);

					const lines: string[] = [];
					for (let i = startIndex; i < endIndex; i++) {
						const m = filtered[i];
						const isSelected = i === selectedIndex;
						const checkmark = m.isCurrent ? theme.fg("success", " ✓") : "";
						const providerBadge = theme.fg("muted", `[${m.provider}]`);

						if (isSelected) {
							lines.push(`${theme.fg("accent", "→ " + m.id)} ${providerBadge}${checkmark}`);
						} else {
							lines.push(`  ${m.id} ${providerBadge}${checkmark}`);
						}
					}

					// Scroll indicator
					if (filtered.length > maxVisible) {
						lines.push(theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`));
					}

					listText.text = lines.join("\n");

					// Detail line: model name
					const sel = filtered[selectedIndex];
					if (sel) {
						detailText.text = theme.fg("muted", `  Model Name: ${sel.name}`);
					} else {
						detailText.text = "";
					}
				}

				renderList();

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.up)) {
							selectedIndex = selectedIndex <= 0 ? filtered.length - 1 : selectedIndex - 1;
							renderList();
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							selectedIndex = selectedIndex >= filtered.length - 1 ? 0 : selectedIndex + 1;
							renderList();
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							if (filtered.length > 0) {
								const sel = filtered[selectedIndex];
								done(`${sel.provider}/${sel.id}`);
							}
						} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(null);
						} else {
							searchInput.handleInput(data);
							searchText = searchInput.value;
							applyFilter();
							renderList();
							tui.requestRender();
						}
					},
				};
			});

			if (!choice) return;

			subagentModel = choice;

			// Step 2: pick thinking level
			const thinkingLevels = [
				{ value: undefined,    label: "default",  desc: "Use pi default from settings" },
				{ value: "off",        label: "off",      desc: "No reasoning — fastest, cheapest" },
				{ value: "minimal",    label: "minimal",  desc: "1k token budget — barely any reasoning" },
				{ value: "low",        label: "low",      desc: "2k token budget — light reasoning" },
				{ value: "medium",     label: "medium",   desc: "8k token budget — moderate reasoning" },
				{ value: "high",       label: "high",     desc: "16k token budget — complex tasks" },
				{ value: "xhigh",      label: "xhigh",    desc: "Max reasoning — Opus 4.6 / GPT-5 only" },
			];

			const chosenThinking = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				let selectedIndex = thinkingLevels.findIndex((l) => l.value === subagentThinking);
				if (selectedIndex < 0) selectedIndex = 0;

				const container = new Container();
				const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(topBorder);

				const headerText = new Text(theme.fg("muted", `  Select thinking level for ${subagentModel}`), 0, 1);
				container.addChild(headerText);

				container.addChild(new Text("", 0, 1));

				const listText = new Text("", 0, 0);
				container.addChild(listText);

				const descText = new Text("", 0, 1);
				container.addChild(descText);

				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(bottomBorder);

				function renderThinkingList() {
					const lines = thinkingLevels.map((l, i) => {
						const isSelected = i === selectedIndex;
						const isCurrent = l.value === subagentThinking || (l.value === undefined && subagentThinking === undefined);
						const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
						if (isSelected) {
							return `${theme.fg("accent", "→ " + l.label)}${checkmark}`;
						}
						return `  ${l.label}${checkmark}`;
					});
					listText.text = lines.join("\n");
					descText.text = theme.fg("muted", `  ${thinkingLevels[selectedIndex]?.desc || ""}`);
				}

				renderThinkingList();

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.up)) {
							selectedIndex = selectedIndex <= 0 ? thinkingLevels.length - 1 : selectedIndex - 1;
							renderThinkingList();
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							selectedIndex = selectedIndex >= thinkingLevels.length - 1 ? 0 : selectedIndex + 1;
							renderThinkingList();
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							done(thinkingLevels[selectedIndex]?.value ?? "__default__");
						} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(null);
						}
					},
				};
			});

			if (chosenThinking !== null) {
				subagentThinking = chosenThinking === "__default__" ? undefined : chosenThinking;
			}

			updateStatusBar(ctx);
			const thinkingMsg = subagentThinking ? ` | thinking: ${subagentThinking}` : "";
			ctx.ui.notify(`Subagent model set to: ${subagentModel}${thinkingMsg}`, "info");
		},
	});

	pi.registerCommand("thinking-sub", {
		description: "Set the default thinking level for thread workers",
		handler: async (args, ctx) => {
			const input = args.trim().toLowerCase();
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];

			if (!input) {
				ctx.ui.notify(`🧠 Subagent thinking: ${subagentThinking || "(pi default)"}. Usage: /thinking-sub ${levels.join("|")}|reset`, "info");
				return;
			}

			if (input === "reset" || input === "default") {
				subagentThinking = undefined;
				ctx.ui.notify("🧠 Subagent thinking reset to pi default", "info");
				updateStatusBar(ctx);
				return;
			}

			if (!levels.includes(input)) {
				ctx.ui.notify(`Invalid level. Use: ${levels.join(", ")} or "reset"`, "warn");
				return;
			}

			subagentThinking = input;
			ctx.ui.notify(`🧠 Subagent thinking set to: ${input}`, "info");
			updateStatusBar(ctx);
		},
	});

	// Reconstruct state on session load
	pi.on("session_start", async (_event, ctx) => {
		episodeCounts.clear();
		threadStats.clear();

		// Strip built-in tools — orchestrator only dispatches
		const allTools = pi.getAllTools();
		const keepTools = allTools.map((t) => t.name).filter((n) => !["read", "write", "edit", "bash", "grep", "find", "ls"].includes(n));
		if (keepTools.length > 0) {
			pi.setActiveTools(keepTools);
		}

		// Reconstruct episode counts from session history
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				if (entry.message.toolName === "dispatch") {
					const details = entry.message.details as DispatchDetails | undefined;
					if (details?.items) {
						for (const item of details.items) {
							episodeCounts.set(item.thread, Math.max(episodeCounts.get(item.thread) || 0, item.episodeNumber));
						}
					}
				}
			}
		}

		ctx.ui.notify("🧵 Thread orchestrator active", "info");
		updateStatusBar(ctx);
	});

	// Inject orchestrator system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		let extra = ORCHESTRATOR_PROMPT;

		// Tell the orchestrator about existing threads
		const threads = listThreads(ctx.cwd);
		if (threads.length > 0) {
			const threadInfo = threads.map((t) => {
				const count = episodeCounts.get(t) || 0;
				const stats = threadStats.get(t);
				const contextInfo = stats?.contextTokens ? `, ${formatTokens(stats.contextTokens)} context` : "";
				const compactInfo = stats?.compactionCount ? `, compacted ${stats.compactionCount}×` : "";
				return `  - **${t}** (${count} episode${count !== 1 ? "s" : ""}${contextInfo}${compactInfo})`;
			});
			extra += `\n## Active Threads\n${threadInfo.join("\n")}\n`;
		}

		extra += `\n## Current Subagent Model\n${subagentModel}\n`;
		extra += `\n## Current Subagent Thinking\n${subagentThinking || "(pi default from settings)"}\n`;

		return { systemPrompt: event.systemPrompt + extra };
	});

	// Register the dispatch tool
	pi.registerTool({
		name: "dispatch",
		label: "Dispatch",
		description: [
			"Dispatch actions to named threads.",
			"Single mode: thread + action. Batch mode: tasks array (any number of threads in parallel).",
			"Threads are persistent workers with accumulated context.",
			"Give concrete, direct instructions. The thread executes and returns an episode (compressed result).",
			"Reuse thread names for related work. Create new threads for independent work streams.",
		].join(" "),
		promptSnippet: "Dispatch actions to thread workers (single or batch parallel) and receive compressed episodes back",
		promptGuidelines: [
			"Always use dispatch for ALL work — never use file or shell tools directly.",
			"Give threads concrete, direct instructions like 'Go to file X and change Y to Z' or 'Run command X and show me the output'.",
			"Reuse thread names for related work so threads accumulate useful context.",
			"If a thread reports failure, re-plan and dispatch a new action — don't ask the thread to figure it out.",
		],
		parameters: Type.Object({
			thread: Type.Optional(Type.String({ description: "Thread name — identifies the work stream. Reuse for related actions. (single mode)" })),
			action: Type.Optional(Type.String({ description: "Direct, concrete instructions for the thread to execute. (single mode)" })),
			thinking: Type.Optional(Type.String({ description: "Thinking level for this dispatch: off, minimal, low, medium, high, xhigh. Defaults to global subagent thinking level." })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						thread: Type.String({ description: "Thread name" }),
						action: Type.String({ description: "Action for this thread" }),
						thinking: Type.Optional(Type.String({ description: "Thinking level for this task: off, minimal, low, medium, high, xhigh" })),
					}),
					{ description: "Batch mode: thread actions dispatched in parallel." },
				),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = subagentModel;
			const defaultThinking = subagentThinking;

			// Determine mode
			const hasBatch = params.tasks && params.tasks.length > 0;
			const hasSingle = params.thread && params.action;

			if (!hasBatch && !hasSingle) {
				return {
					content: [{ type: "text", text: "Provide either thread+action (single) or tasks array (batch)." }],
					details: { mode: "single" as const, items: [] },
					isError: true,
				};
			}

			const taskList = hasBatch
				? params.tasks!
				: [{ thread: params.thread!, action: params.action!, thinking: params.thinking }];

			const mode = taskList.length > 1 ? "batch" : "single";

			// Track all results for streaming updates in batch mode
			const allItems: (SingleDispatchResult | null)[] = taskList.map(() => null);

			const emitBatchUpdate = () => {
				if (!onUpdate) return;
				const currentItems: SingleDispatchResult[] = allItems
					.filter((i): i is SingleDispatchResult => i !== null);
				if (currentItems.length === 0) return;
				onUpdate({
					content: [{ type: "text", text: currentItems.map((i) => `[${i.thread}] ${i.episode || "(running...)"}`).join("\n\n") }],
					details: { mode, items: currentItems },
				});
			};

			// Run all tasks (parallel for batch, single for single)
			const runOne = async (task: { thread: string; action: string; thinking?: string }, index: number): Promise<SingleDispatchResult> => {
				const episodeNumber = (episodeCounts.get(task.thread) || 0) + 1;

				// For single mode, pass onUpdate directly for live streaming
				// For batch mode, create a per-task updater that updates this task's slot and emits
				const taskOnUpdate = mode === "single"
					? onUpdate
					: onUpdate
						? (partial: AgentToolResult<DispatchDetails>) => {
								// Update this task's in-progress slot
								const inProgress = partial.details?.items?.[0];
								if (inProgress) {
									allItems[index] = inProgress;
								}
								emitBatchUpdate();
							}
						: undefined;

				const thinking = task.thinking || defaultThinking;
				const result = await runThreadAction(
					ctx.cwd, task.thread, task.action, model, thinking, signal,
					taskOnUpdate,
					episodeNumber,
				);

				// Build episode directly — tool call history + last message, no extra model call
				const episode = buildEpisode(result.messages, result.compaction);
				episodeCounts.set(task.thread, episodeNumber);

				// Update thread context stats
				const existingStats = threadStats.get(task.thread) || { contextTokens: 0, lastCompactedAt: 0, compactionCount: 0 };
				existingStats.contextTokens = result.usage.contextTokens;
				if (result.compaction) {
					existingStats.lastCompactedAt = Date.now();
					existingStats.compactionCount++;
				}
				threadStats.set(task.thread, existingStats);

				const item: SingleDispatchResult = { thread: task.thread, action: task.action, episode, episodeNumber, result };
				allItems[index] = item;
				if (mode === "batch") emitBatchUpdate();
				return item;
			};

			let items: SingleDispatchResult[];
			if (taskList.length === 1) {
				items = [await runOne(taskList[0], 0)];
			} else {
				items = await Promise.all(taskList.map((t, i) => runOne(t, i)));
			}

			const anyError = items.some(
				(i) => i.result.exitCode !== 0 || i.result.stopReason === "error" || i.result.stopReason === "aborted",
			);

			const contentText = items.map((i) => `[${i.thread}] ${i.episode}`).join("\n\n");

			return {
				content: [{ type: "text", text: contentText }],
				details: { mode, items },
				isError: anyError ? true : undefined,
			};
		},

		// ─── Rendering ───

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				return {
					render(width: number): string[] {
						return renderColumnsInRows(
							args.tasks.map((t: { thread: string; action: string }) => (colWidth: number) => {
								const header = theme.fg("accent", theme.bold(`[${t.thread}]`));
								const actionLines = wrapText(t.action, colWidth - 1);
								return [header, ...actionLines.map((l: string) => theme.fg("dim", l))];
							}),
							width,
							theme,
						);
					},
					invalidate(): void {},
				};
			}

			// Single dispatch
			const threadName = args.thread || "...";
			const actionText = args.action || "...";

			return {
				render(width: number): string[] {
					const header = theme.fg("toolTitle", theme.bold("dispatch ")) + theme.fg("accent", theme.bold(`[${threadName}]`));
					const actionLines = wrapText(actionText, width - 2);
					return [header, ...actionLines.map((l: string) => "  " + theme.fg("dim", l))];
				},
				invalidate(): void {},
			};
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as DispatchDetails | undefined;

			if (!details || details.items.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const renderSingleItem = (item: SingleDispatchResult, isExpanded: boolean) => {
				const r = item.result;
				const isRunning = !item.episode || item.episode === "(running...)";
				const isError = !isRunning && (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted");
				const threadLabel = theme.fg("accent", theme.bold(`[${item.thread}]`));
				const epLabel = theme.fg("muted", `ep${item.episodeNumber}`);
				const modelLabel = r.model ? theme.fg("dim", r.model) : "";

				// ── Running state: action + live tool calls + stats ──
				if (isRunning) {
					return {
						render(colWidth: number): string[] {
							const lines: string[] = [];

							// Status line: ⏳ turns · cost · context
							const statParts: string[] = [];
							if (r.usage.turns) statParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
							if (r.usage.cost) statParts.push(`$${r.usage.cost.toFixed(2)}`);
							if (r.usage.contextTokens > 0) statParts.push(`ctx:${formatTokens(r.usage.contextTokens)}`);
							if (statParts.length > 0) {
								lines.push(theme.fg("warning", "⏳") + " " + theme.fg("dim", statParts.join(" · ")));
							}

							// Live tool calls
							const displayItems = getDisplayItems(r.messages);
							const toolCalls = displayItems.filter((i) => i.type === "toolCall");
							for (const tc of toolCalls) {
								if (tc.type === "toolCall") {
									lines.push(theme.fg("muted", "→ ") + formatToolCall(tc.name, tc.args, theme.fg.bind(theme)));
								}
							}

							return lines.map((l) => truncateToWidth(l, colWidth));
						},
						invalidate(): void {},
					};
				}

				// ── Done state: episode ──
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const newBadge = r.isNewThread ? theme.fg("warning", " new") : "";

				if (isExpanded) {
					const mdTheme = getMarkdownTheme();
					const container = new Container();
					container.addChild(new Text(`${icon} ${threadLabel} ${epLabel} ${modelLabel}${newBadge}`, 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Action ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", item.action), 0, 0));

					const displayItems = getDisplayItems(r.messages);
					const toolCalls = displayItems.filter((i) => i.type === "toolCall");
					if (toolCalls.length > 0) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
						for (const tc of toolCalls) {
							if (tc.type === "toolCall") {
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(tc.name, tc.args, theme.fg.bind(theme)), 0, 0),
								);
							}
						}
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Episode ───"), 0, 0));
					container.addChild(new Markdown(item.episode.trim(), 0, 0, mdTheme));

					const usageStr = formatUsage(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				// Collapsed done
				let text = `${icon} ${threadLabel} ${epLabel} ${modelLabel}${newBadge}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", r.errorMessage)}`;
				text += `\n${item.episode}`;
				const usageStr = formatUsage(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			};

			// Single mode: render as before
			if (details.mode === "single" || details.items.length === 1) {
				const component = renderSingleItem(details.items[0], expanded);
				if (!expanded) {
					const container = new Container();
					container.addChild(component);
					container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
					return container;
				}
				return component;
			}

			// Batch mode: render in columns
			// Batch mode: render in rows of 3 columns
			return {
				render(width: number): string[] {
					const lines = renderColumnsInRows(
						details.items.map((item) => (colWidth: number) => {
							const component = renderSingleItem(item, expanded);
							return component.render(colWidth);
						}),
						width,
						theme,
					);
					if (!expanded) lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
					return lines;
				},
				invalidate(): void {},
			};
		},
	});
}
