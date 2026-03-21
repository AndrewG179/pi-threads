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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { buildEpisode as buildThreadEpisode } from "./src/episode/builder";
import { PiActorRuntime } from "./src/runtime/pi-actor";
import { ThreadSupervisor } from "./src/runtime/thread-supervisor";
import { collectSubagentCards, loadSessionBranchFromFile, type SubagentCard } from "./src/subagents/metadata";
import { deriveSessionBehavior, resolveActiveToolsForBehavior } from "./src/subagents/mode";
import { SubagentSelector } from "./src/subagents/selector";
import { loadThreadsState, rememberParentSession, saveThreadsState } from "./src/subagents/state";

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

const piActorRuntime = new PiActorRuntime();
const threadSupervisor = new ThreadSupervisor(piActorRuntime);

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

## Dispatch Examples

Good — asks for specific information:
- \`dispatch(thread: "backend", action: "Read src/api/routes.ts and list every route with its HTTP method, path, and handler function name")\`
- \`dispatch(thread: "debug", action: "Run pytest -x and tell me if it passes. If it fails, show the first failure's test name, assertion, and traceback")\`
- \`dispatch(thread: "infra", action: "Check if nginx is running on 10.0.1.50, and show the upstream config block for the API service")\`

Bad — dumps raw content into your context:
- ~~\`dispatch(thread: "x", action: "Show me the complete contents of README.md")\`~~
- ~~\`dispatch(thread: "x", action: "Run find . -type f and paste the output")\`~~

Batch (parallel, shown side by side in groups of 3):
- \`dispatch(tasks: [{thread: "auth", action: "Read auth middleware and list exported functions with signatures"}, {thread: "tests", action: "Run the test suite and report pass/fail counts"}, {thread: "docs", action: "Check if API docs exist and list what endpoints are documented"}])\`
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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

const MAX_COLUMNS = 3;
const CTRL_B_INPUT = "\u0002";

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

async function runThreadAction(
	cwd: string,
	threadName: string,
	action: string,
	model: string | undefined,
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
		if (msg.role !== "assistant") return;

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
	};

	const emitUpdate = () => {
		if (!onUpdate) return;
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
	};

	const runId = `${threadName}:${episodeNumber}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
	const handle = threadSupervisor.invoke(
		{
			runId,
			thread: threadName,
			cwd,
			action,
			model,
			sessionPath,
			systemPrompt: THREAD_WORKER_PROMPT,
		},
		{ signal },
	);

	const unsubscribe = handle.subscribe((event) => {
		if (event.type === "message") {
			const threadedMessage = event.message as Message;
			result.messages.push(threadedMessage);
			trackUsage(threadedMessage);
			emitUpdate();
		}
		if (event.type === "stderr") {
			result.stderr += event.chunk;
		}
	});

	const runtimeResult = await handle.result.finally(() => {
		unsubscribe();
	});

	result.messages = runtimeResult.messages as Message[];
	result.stderr = runtimeResult.stderr;
	result.usage = { ...runtimeResult.usage };
	result.model = runtimeResult.model ?? result.model;
	result.stopReason = runtimeResult.stopReason;
	result.errorMessage = runtimeResult.errorMessage;
	result.exitCode = runtimeResult.finalState.exitCode ?? (runtimeResult.finalState.signal ? 1 : 0);

	if (!result.stopReason && runtimeResult.finalState.requestedTerminationReason === "abort") {
		result.stopReason = "aborted";
	}

	return result;
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

function getDispatchFailureSummary(result: Pick<ThreadActionResult, "errorMessage" | "stderr">): string | undefined {
	const errorText = result.errorMessage?.trim() || result.stderr.trim();
	return errorText ? `THREAD ERROR:\n${errorText}` : undefined;
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
	let defaultActiveTools: string[] | null = null;
	let lastCommandSwitchSession: ((sessionPath: string) => Promise<{ cancelled: boolean }>) | null = null;
	let releaseSubagentBackListener: (() => void) | null = null;

	const rebuildEpisodeCounts = (sessionManager: { getBranch(): Array<{ type: string; message: { role: string; toolName?: string; details?: unknown } }> }) => {
		episodeCounts.clear();
		for (const entry of sessionManager.getBranch()) {
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
	};

	const renderSubagentBanner = (ctx: { ui: { theme: any; setWidget: (key: string, content: unknown, options?: unknown) => void } }, behavior: ReturnType<typeof deriveSessionBehavior>) => {
		if (behavior.kind !== "subagent") {
			ctx.ui.setWidget("pi-threads-subagent-banner", undefined);
			return;
		}

		const parentLabel = behavior.parentSessionFile ? path.basename(behavior.parentSessionFile) : "unknown";
		ctx.ui.setWidget(
			"pi-threads-subagent-banner",
			[
				ctx.ui.theme.fg("warning", `Subagent [${behavior.threadName ?? "thread"}]`) + ctx.ui.theme.fg("dim", `  parent ${parentLabel}`),
				ctx.ui.theme.fg("dim", "Ctrl+B or /subagents-back to return · /subagents to switch threads"),
			],
			{ placement: "aboveEditor" },
		);
	};

	const syncSessionMode = (ctx: {
		hasUI?: boolean;
		cwd: string;
		sessionManager: { getSessionFile(): string | undefined; getBranch(): Array<{ type: string; message: { role: string; toolName?: string; details?: unknown } }> };
		ui: {
			onTerminalInput?: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void;
			theme: any;
			setStatus: (key: string, text: string | undefined) => void;
			setWidget: (key: string, content: unknown, options?: unknown) => void;
		};
	}) => {
		const state = loadThreadsState(ctx.cwd);
		const behavior = deriveSessionBehavior({
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			state,
		});

		if (!defaultActiveTools) {
			defaultActiveTools = pi.getActiveTools().filter((tool) => tool !== "dispatch");
		}

		const allToolNames = pi.getAllTools().map((tool) => tool.name);
		const nextActiveTools = resolveActiveToolsForBehavior(
			behavior.kind,
			defaultActiveTools ?? allToolNames,
			allToolNames,
		);
		pi.setActiveTools(nextActiveTools);

		releaseSubagentBackListener?.();
		releaseSubagentBackListener = null;
		if (behavior.kind === "subagent" && ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
			releaseSubagentBackListener = ctx.ui.onTerminalInput((data) => {
				if (data !== CTRL_B_INPUT) return undefined;
				return { data: "/subagents-back\n" };
			});
		}

		if (behavior.kind === "orchestrator") {
			ctx.ui.setStatus("pi-threads", ctx.ui.theme.fg("accent", "threads:on"));
		} else if (behavior.kind === "subagent") {
			ctx.ui.setStatus("pi-threads", ctx.ui.theme.fg("warning", `subagent:${behavior.threadName ?? "thread"}`));
		} else {
			ctx.ui.setStatus("pi-threads", undefined);
		}

		renderSubagentBanner(ctx, behavior);
		rebuildEpisodeCounts(ctx.sessionManager);
		return behavior;
	};

	const rememberCommandSessionSwitcher = (ctx: {
		switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	}) => {
		lastCommandSwitchSession = ctx.switchSession.bind(ctx);
	};

	const switchToRememberedParent = async (ctx: {
		cwd: string;
		sessionManager: { getSessionFile(): string | undefined };
		ui: { notify: (message: string, level?: string) => void };
		switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	}) => {
		const behavior = deriveSessionBehavior({
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			state: loadThreadsState(ctx.cwd),
		});
		if (behavior.kind !== "subagent" || !behavior.parentSessionFile) {
			ctx.ui.notify("No remembered parent session for this thread.", "warning");
			return;
		}

		const switchSession = ctx.switchSession ?? lastCommandSwitchSession;
		if (!switchSession) {
			ctx.ui.notify("Ctrl+B cannot switch sessions yet in this runtime. Use /subagents-back.", "warning");
			return;
		}

		await switchSession(behavior.parentSessionFile);
	};

	// Reconstruct state on session load
	pi.on("session_start", async (_event, ctx) => {
		syncSessionMode(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		syncSessionMode(ctx);
	});

	// Inject orchestrator system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		const behavior = deriveSessionBehavior({
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			state: loadThreadsState(ctx.cwd),
		});
		if (!behavior.shouldAppendOrchestratorPrompt) return;

		let extra = ORCHESTRATOR_PROMPT;

		// Tell the orchestrator about existing threads
		const threads = listThreads(ctx.cwd);
		if (threads.length > 0) {
			const threadInfo = threads.map((t) => {
				const count = episodeCounts.get(t) || 0;
				return `  - **${t}** (${count} episode${count !== 1 ? "s" : ""})`;
			});
			extra += `\n## Active Threads\n${threadInfo.join("\n")}\n`;
		}

		return { systemPrompt: event.systemPrompt + extra };
	});

	pi.registerCommand("threads", {
		description: "Turn thread orchestrator mode on or off for this project",
		getArgumentCompletions(prefix) {
			const values = ["on", "off"].filter((value) => value.startsWith(prefix));
			return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			rememberCommandSessionSwitcher(ctx);
			const nextMode = args.trim().toLowerCase();
			if (nextMode !== "on" && nextMode !== "off") {
				const state = loadThreadsState(ctx.cwd);
				ctx.ui.notify(`Thread mode is ${state.enabled ? "on" : "off"}. Use /threads on or /threads off.`, "info");
				return;
			}

			const state = loadThreadsState(ctx.cwd);
			saveThreadsState(ctx.cwd, { ...state, enabled: nextMode === "on" });
			syncSessionMode(ctx);
			ctx.ui.notify(`Thread mode ${nextMode}.`, "info");
		},
	});

	pi.registerCommand("subagents-back", {
		description: "Return from the current subagent session to its remembered parent session",
		handler: async (_args, ctx) => {
			rememberCommandSessionSwitcher(ctx);
			await switchToRememberedParent(ctx);
		},
	});

	pi.registerShortcut("ctrl+b", {
		description: "Return to remembered parent session from a subagent",
		handler: async (ctx) => {
			await switchToRememberedParent(ctx);
		},
	});

	pi.registerCommand("subagents", {
		description: "Browse and open known subagent thread sessions",
		handler: async (_args, ctx) => {
			rememberCommandSessionSwitcher(ctx);
			if (!ctx.hasUI) {
				ctx.ui.notify("The /subagents selector requires the interactive UI.", "warning");
				return;
			}

			const state = loadThreadsState(ctx.cwd);
			const behavior = deriveSessionBehavior({
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile(),
				state,
			});

			const parentSessionFile = behavior.parentSessionFile ?? behavior.sessionFile;
			if (!parentSessionFile) {
				ctx.ui.notify("Current session is not persisted, so parent navigation cannot be remembered.", "warning");
				return;
			}

			const parentEntries = behavior.parentSessionFile
				? loadSessionBranchFromFile(behavior.parentSessionFile)
				: ctx.sessionManager.getBranch();

			const cards = collectSubagentCards(ctx.cwd, parentEntries);
			const selected = await ctx.ui.custom<SubagentCard | undefined>(
				(_tui, theme, _keybindings, done) => new SubagentSelector(cards, theme, done),
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						maxHeight: "80%",
						anchor: "center",
						margin: 1,
					},
				},
			);

			if (!selected) return;
			if (selected.sessionPath === ctx.sessionManager.getSessionFile()) return;

			const nextState = rememberParentSession(state, selected.sessionPath, parentSessionFile);
			saveThreadsState(ctx.cwd, nextState);
			await ctx.switchSession(selected.sessionPath);
		},
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
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						thread: Type.String({ description: "Thread name" }),
						action: Type.String({ description: "Action for this thread" }),
					}),
					{ description: "Batch mode: thread actions dispatched in parallel." },
				),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			let threadsState = loadThreadsState(ctx.cwd);
			const dispatchBehavior = deriveSessionBehavior({
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile(),
				state: threadsState,
			});
			const rememberedParentSession = dispatchBehavior.parentSessionFile ?? dispatchBehavior.sessionFile;

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
				: [{ thread: params.thread!, action: params.action! }];

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
			const runOne = async (task: { thread: string; action: string }, index: number): Promise<SingleDispatchResult> => {
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

				const sessionPath = getThreadSessionPath(ctx.cwd, task.thread);
				if (rememberedParentSession) {
					threadsState = rememberParentSession(threadsState, sessionPath, rememberedParentSession);
					saveThreadsState(ctx.cwd, threadsState);
				}

				const pendingItem: SingleDispatchResult = {
					thread: task.thread,
					action: task.action,
					episode: "(running...)",
					episodeNumber,
					result: {
						thread: task.thread,
						action: task.action,
						exitCode: 0,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						model,
						sessionPath,
						isNewThread: !fs.existsSync(sessionPath),
					},
				};
				allItems[index] = pendingItem;
				taskOnUpdate?.({
					content: [{ type: "text", text: "(running...)" }],
					details: { mode: "single", items: [pendingItem] },
				});

				const result = await runThreadAction(
					ctx.cwd, task.thread, task.action, model, signal,
					taskOnUpdate,
					episodeNumber,
				);

				// Build episode from normalized messages (tool calls + tool results + assistant response)
				const episode = buildThreadEpisode(
					result.messages as Parameters<typeof buildThreadEpisode>[0],
					{ emptyFallback: getDispatchFailureSummary(result) },
				);
				episodeCounts.set(task.thread, episodeNumber);

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
			const tasks = args.tasks;
			if (tasks && tasks.length > 0) {
				return {
					render(width: number): string[] {
						return renderColumnsInRows(
							tasks.map((t: { thread: string; action: string }) => (colWidth: number) => {
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
				const newBadge = r.isNewThread ? theme.fg("warning", " new") : "";

				// ── Running state: action + live tool calls + stats ──
				if (isRunning) {
					return {
						render(colWidth: number): string[] {
							const lines: string[] = [];
							lines.push(`${theme.fg("warning", "⏳")} ${threadLabel} ${epLabel} ${modelLabel}${newBadge}`.trim());

							const maxActionLines = isExpanded ? 3 : 1;
							const actionLines = wrapText(item.action, Math.max(10, colWidth - 2)).slice(0, maxActionLines);
							lines.push(...actionLines.map((line) => `  ${theme.fg("dim", line)}`));

							// Status line: ⏳ turns · cost · context
							const statParts: string[] = [];
							if (r.usage.turns) statParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
							if (r.usage.cost) statParts.push(`$${r.usage.cost.toFixed(2)}`);
							if (r.usage.contextTokens > 0) statParts.push(`ctx:${formatTokens(r.usage.contextTokens)}`);
							if (statParts.length > 0) {
								lines.push(theme.fg("dim", statParts.join(" · ")));
							}

							// Live tool calls
							const displayItems = getDisplayItems(r.messages);
							const toolCalls = displayItems.filter((i) => i.type === "toolCall");
							for (const tc of toolCalls) {
								if (tc.type === "toolCall") {
									lines.push(theme.fg("muted", "→ ") + formatToolCall(tc.name, tc.args, theme.fg.bind(theme)));
								}
							}

							if (toolCalls.length === 0) {
								lines.push(theme.fg("muted", "starting..."));
							}

							return lines;
						},
						invalidate(): void {},
					};
				}

				// ── Done state: episode ──
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

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
