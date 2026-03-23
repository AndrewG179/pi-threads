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
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { buildEpisode as buildThreadEpisode } from "./src/episode/builder";
import { PiActorRuntime } from "./src/runtime/pi-actor";
import { ThreadSupervisor } from "./src/runtime/thread-supervisor";
import { collectSubagentCards, loadSessionBranchFromFile, type SubagentCard } from "./src/subagents/metadata";
import { deriveSessionBehavior, resolveActiveToolsForBehavior } from "./src/subagents/mode";
import { loadThreadsState, saveThreadsState } from "./src/subagents/state";
import { SubagentBrowser } from "./src/subagents/view";
import { wrapText } from "./src/text/wrap";

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

function createEmptyUsageStats(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function createEmptyThreadActionResult(params: {
	thread: string;
	action: string;
	model: string | undefined;
	sessionPath: string;
	isNewThread: boolean;
}): ThreadActionResult {
	return {
		thread: params.thread,
		action: params.action,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: createEmptyUsageStats(),
		model: params.model,
		sessionPath: params.sessionPath,
		isNewThread: params.isNewThread,
	};
}

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

	const result = createEmptyThreadActionResult({
		thread: threadName,
		action,
		model,
		sessionPath,
		isNewThread,
	});

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

function summarizeDispatchItem(item: SingleDispatchResult, theme: any): string {
	const { result } = item;
	const isRunning = !item.episode || item.episode === "(running...)";
	const isError = !isRunning && (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
	const icon = isRunning
		? theme.fg("warning", "...")
		: isError
			? theme.fg("error", "x")
			: theme.fg("success", "ok");
	const headerParts = [
		icon,
		theme.fg("accent", `[${item.thread}]`),
		theme.fg("muted", `ep${item.episodeNumber}`),
		result.model ? theme.fg("dim", result.model) : "",
		result.isNewThread ? theme.fg("warning", "new") : "",
	].filter(Boolean);
	const lines = [headerParts.join(" ")];
	const summaryText = isRunning ? item.action : item.episode;
	if (summaryText) {
		lines.push(summaryText);
	}
	if (isError && result.errorMessage) {
		lines.push(theme.fg("error", result.errorMessage));
	}
	const usage = formatUsage(result.usage);
	if (usage) {
		lines.push(theme.fg("dim", usage));
	}
	return lines.join("\n");
}

// ─── Extension ───

export default function (pi: ExtensionAPI) {
	// Track episode counts per thread (reconstructed from session)
	const episodeCounts = new Map<string, number>();
	let defaultActiveTools: string[] | null = null;
	let lastSessionSwitchSession: ((sessionPath: string) => Promise<{ cancelled: boolean }>) | null = null;
	let releaseSubagentBackListener: (() => void) | null = null;
	const runtimeParentByChildSession = new Map<string, string>();
	const runtimeChildrenByParentSession = new Map<string, Map<string, string>>();
	const activeParentDispatchCounts = new Map<string, number>();

	const arraysEqual = (left: string[], right: string[]) =>
		left.length === right.length && left.every((value, index) => value === right[index]);

	const normalizeSessionPath = (sessionPath: string | undefined): string | undefined =>
		sessionPath ? path.resolve(sessionPath) : undefined;

	const rememberRuntimeSubagent = (parentSessionFile: string, thread: string, childSessionFile: string) => {
		const resolvedParent = path.resolve(parentSessionFile);
		const resolvedChild = path.resolve(childSessionFile);
		runtimeParentByChildSession.set(resolvedChild, resolvedParent);

		const currentChildren = runtimeChildrenByParentSession.get(resolvedParent) ?? new Map<string, string>();
		currentChildren.set(thread, resolvedChild);
		runtimeChildrenByParentSession.set(resolvedParent, currentChildren);
	};

	const getRuntimeParentSession = (sessionFile: string | undefined): string | undefined => {
		const resolvedSession = normalizeSessionPath(sessionFile);
		return resolvedSession ? runtimeParentByChildSession.get(resolvedSession) : undefined;
	};

	const getRuntimeSessionsForParent = (parentSessionFile: string | undefined): Map<string, string> => {
		const resolvedParent = normalizeSessionPath(parentSessionFile);
		if (!resolvedParent) return new Map<string, string>();
		return new Map(runtimeChildrenByParentSession.get(resolvedParent) ?? []);
	};

	const trackActiveParentDispatch = (sessionFile: string | undefined, behaviorKind: ReturnType<typeof deriveSessionBehavior>["kind"]) => {
		const resolvedSessionFile = normalizeSessionPath(sessionFile);
		if (behaviorKind !== "orchestrator" || !resolvedSessionFile) {
			return () => {};
		}

		activeParentDispatchCounts.set(resolvedSessionFile, (activeParentDispatchCounts.get(resolvedSessionFile) ?? 0) + 1);
		return () => {
			const currentCount = activeParentDispatchCounts.get(resolvedSessionFile) ?? 0;
			if (currentCount <= 1) {
				activeParentDispatchCounts.delete(resolvedSessionFile);
				return;
			}
			activeParentDispatchCounts.set(resolvedSessionFile, currentCount - 1);
		};
	};

	const hasActiveParentDispatch = (sessionFile: string | undefined): boolean => {
		const resolvedSessionFile = normalizeSessionPath(sessionFile);
		if (!resolvedSessionFile) return false;
		return (activeParentDispatchCounts.get(resolvedSessionFile) ?? 0) > 0;
	};

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

	const resolveSessionContext = (ctx: {
		cwd: string;
		sessionManager: { getSessionFile(): string | undefined };
	}) => {
		const state = loadThreadsState(ctx.cwd);
		const sessionFile = normalizeSessionPath(ctx.sessionManager.getSessionFile());
		const behavior = deriveSessionBehavior({
			cwd: ctx.cwd,
			sessionFile,
			state,
		});
		const runtimeParentSessionFile = behavior.kind === "subagent" ? getRuntimeParentSession(sessionFile) : undefined;
		return { state, behavior, sessionFile, runtimeParentSessionFile };
	};

	const getUnsafeSubagentSwitchParentSession = (
		ctx: {
			cwd: string;
			sessionManager: { getSessionFile(): string | undefined };
		},
		targetSessionFile: string | undefined,
	): string | undefined => {
		const { state, behavior, sessionFile, runtimeParentSessionFile } = resolveSessionContext(ctx);
		const normalizedTargetSessionFile = normalizeSessionPath(targetSessionFile);
		if (!normalizedTargetSessionFile || normalizedTargetSessionFile === sessionFile) {
			return undefined;
		}

		const targetBehavior = deriveSessionBehavior({
			cwd: ctx.cwd,
			sessionFile: normalizedTargetSessionFile,
			state,
		});

		if (behavior.kind === "orchestrator" && targetBehavior.kind === "subagent" && hasActiveParentDispatch(sessionFile)) {
			return sessionFile;
		}

		if (behavior.kind === "subagent" && runtimeParentSessionFile && hasActiveParentDispatch(runtimeParentSessionFile)) {
			return runtimeParentSessionFile;
		}

		return undefined;
	};

	const formatUnsafeSubagentSwitchMessage = (parentSessionFile: string): string =>
		`Blocked session switch: parent dispatch is still running in ${path.basename(parentSessionFile)}. ` +
		"Switching into or out of a subagent now would stop that in-flight dispatch. Wait for the dispatch to finish, then try again.";

	const notifyIfUnsafeSubagentSwitchWasCancelled = (
		ctx: {
			cwd: string;
			sessionManager: { getSessionFile(): string | undefined };
			ui: { notify: (message: string, level?: string) => void };
		},
		targetSessionFile: string,
		switchResult: { cancelled: boolean } | undefined,
	): boolean => {
		if (!switchResult?.cancelled) {
			return false;
		}

		const parentSessionFile = getUnsafeSubagentSwitchParentSession(ctx, targetSessionFile);
		if (!parentSessionFile) {
			return false;
		}

		ctx.ui.notify(formatUnsafeSubagentSwitchMessage(parentSessionFile), "warning");
		return true;
	};

	const renderSubagentBanner = (
		ctx: { ui: { theme: any; setWidget: (key: string, content: unknown, options?: unknown) => void } },
		behavior: ReturnType<typeof deriveSessionBehavior>,
		runtimeParentSessionFile?: string,
	) => {
		if (behavior.kind !== "subagent") {
			ctx.ui.setWidget("pi-threads-subagent-banner", undefined);
			return;
		}

		const parentLabel = runtimeParentSessionFile ? path.basename(runtimeParentSessionFile) : "current runtime only";
		const navigationHint = runtimeParentSessionFile
			? "Ctrl+B or /subagents-back to return · /subagents to switch threads"
			: "/subagents to switch threads";
		ctx.ui.setWidget(
			"pi-threads-subagent-banner",
			[
				ctx.ui.theme.fg("warning", `Subagent [${behavior.threadName ?? "thread"}]`) + ctx.ui.theme.fg("dim", `  parent ${parentLabel}`),
				ctx.ui.theme.fg("dim", navigationHint),
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
		const { behavior, runtimeParentSessionFile } = resolveSessionContext(ctx);
		const currentActiveTools = pi.getActiveTools().filter((tool) => tool !== "dispatch");
		const allToolNames = pi.getAllTools().map((tool) => tool.name);

		if (!defaultActiveTools) {
			defaultActiveTools = currentActiveTools;
		}

		const strippedCachedTools = resolveActiveToolsForBehavior("orchestrator", defaultActiveTools, allToolNames)
			.filter((tool) => tool !== "dispatch");
		const isCurrentToolsetCached = arraysEqual(currentActiveTools, strippedCachedTools);
		if (!isCurrentToolsetCached) {
			defaultActiveTools = currentActiveTools;
		}

		const nextActiveTools = resolveActiveToolsForBehavior(
			behavior.kind,
			behavior.kind === "orchestrator" || isCurrentToolsetCached ? defaultActiveTools : currentActiveTools,
			allToolNames,
		);
		pi.setActiveTools(nextActiveTools);

		releaseSubagentBackListener?.();
		releaseSubagentBackListener = null;
		if (behavior.kind === "subagent" && runtimeParentSessionFile && ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
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

		renderSubagentBanner(ctx, behavior, runtimeParentSessionFile);
		rebuildEpisodeCounts(ctx.sessionManager);
		return behavior;
	};

	const rememberSessionSwitcher = (ctx: {
		switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	}) => {
		if (typeof ctx.switchSession !== "function") {
			return;
		}
		lastSessionSwitchSession = ctx.switchSession.bind(ctx);
	};

	const switchToRememberedParent = async (ctx: {
		cwd: string;
		sessionManager: { getSessionFile(): string | undefined };
		ui: { notify: (message: string, level?: string) => void };
		switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	}) => {
		const { behavior, runtimeParentSessionFile } = resolveSessionContext(ctx);
		if (behavior.kind !== "subagent" || !runtimeParentSessionFile) {
			ctx.ui.notify("No remembered parent session for this thread.", "warning");
			return;
		}

		const switchSession = ctx.switchSession ?? lastSessionSwitchSession;
		if (!switchSession) {
			ctx.ui.notify("Ctrl+B cannot switch sessions yet in this runtime. Use /subagents-back.", "warning");
			return;
		}

		const unsafeParentSessionFile = getUnsafeSubagentSwitchParentSession(ctx, runtimeParentSessionFile);
		if (unsafeParentSessionFile) {
			ctx.ui.notify(formatUnsafeSubagentSwitchMessage(unsafeParentSessionFile), "warning");
			return;
		}

		const switchResult = await switchSession(runtimeParentSessionFile);
		notifyIfUnsafeSubagentSwitchWasCancelled(ctx, runtimeParentSessionFile, switchResult);
	};

	const openSubagentsBrowser = async (ctx: {
		cwd: string;
		hasUI: boolean;
		sessionManager: {
			getSessionFile(): string | undefined;
			getBranch(): Array<{ type: string; message: { role: string; toolName?: string; details?: unknown } }>;
		};
		ui: {
			notify: (message: string, level?: string) => void;
			custom<T>(
				factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => unknown,
				options?: unknown,
			): Promise<T>;
		};
		switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	}) => {
		rememberSessionSwitcher(ctx);
		if (!ctx.hasUI) {
			ctx.ui.notify("The /subagents browser requires the interactive UI.", "warning");
			return;
		}

		const { behavior, sessionFile, runtimeParentSessionFile } = resolveSessionContext(ctx);
		const parentSessionFile = behavior.kind === "subagent" ? runtimeParentSessionFile : sessionFile;
		if (!parentSessionFile) {
			ctx.ui.notify("Current session is not persisted, so parent navigation cannot be remembered.", "warning");
			return;
		}

		const parentEntries = behavior.kind === "subagent" && runtimeParentSessionFile
			? loadSessionBranchFromFile(runtimeParentSessionFile)
			: ctx.sessionManager.getBranch();
		const cards = collectSubagentCards(ctx.cwd, parentEntries, getRuntimeSessionsForParent(parentSessionFile));
		const switchSession = ctx.switchSession ?? lastSessionSwitchSession;
		const selected = await ctx.ui.custom<SubagentCard | undefined>(
			(tui, theme, keybindings, done) =>
				new SubagentBrowser(cards, tui, theme, keybindings, done, async (candidate) => {
					if (candidate.sessionPath === ctx.sessionManager.getSessionFile()) {
						return { kind: "stay" };
					}

					if (!switchSession) {
						return {
							kind: "blocked",
							message: "This runtime cannot switch sessions from the subagent browser yet. Use /subagents.",
						};
					}

					const unsafeParentSessionFile = getUnsafeSubagentSwitchParentSession(ctx, candidate.sessionPath);
					if (unsafeParentSessionFile) {
						return {
							kind: "blocked",
							message: formatUnsafeSubagentSwitchMessage(unsafeParentSessionFile),
						};
					}

					const switchResult = await switchSession(candidate.sessionPath);
					if (switchResult?.cancelled) {
						const parentSessionFile = getUnsafeSubagentSwitchParentSession(ctx, candidate.sessionPath);
						if (parentSessionFile) {
							return {
								kind: "blocked",
								message: formatUnsafeSubagentSwitchMessage(parentSessionFile),
							};
						}

						return {
							kind: "blocked",
							message: "Session switch was cancelled. Stay here and try again when the target session is available.",
						};
					}

					rememberRuntimeSubagent(parentSessionFile, candidate.thread, candidate.sessionPath);
					return { kind: "open" };
				}),
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					row: 0,
					col: 0,
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
			},
		);

		if (!selected) return;
	};

	// Reconstruct state on session load
	pi.on("session_start", async (_event, ctx) => {
		syncSessionMode(ctx);
	});

	pi.on("session_before_switch", async (event: { reason?: string; targetSessionFile?: string }, ctx) => {
		if (event.reason !== "resume") return;

		const parentSessionFile = getUnsafeSubagentSwitchParentSession(ctx, event.targetSessionFile);
		if (!parentSessionFile) return;

		return { cancel: true };
	});

	pi.on("session_switch", async (_event, ctx) => {
		syncSessionMode(ctx);
	});

	// Inject orchestrator system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		const { behavior } = resolveSessionContext(ctx);
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
			rememberSessionSwitcher(ctx);
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

	// Register /subagents before /subagents-back so an exact "/subagents" input
	// wins the host autocomplete tie instead of selecting the back command first.
	pi.registerCommand("subagents", {
		description: "Browse and open current-branch subagent thread sessions",
		handler: async (_args, ctx) => {
			await openSubagentsBrowser(ctx);
		},
	});

	pi.registerCommand("subagents-back", {
		description: "Return from the current subagent session to its remembered parent session",
		handler: async (_args, ctx) => {
			rememberSessionSwitcher(ctx);
			await switchToRememberedParent(ctx);
		},
	});

	pi.registerShortcut("ctrl+o", {
		description: "Browse current-branch subagent sessions",
		handler: async (ctx) => {
			await openSubagentsBrowser(ctx as typeof ctx & {
				switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
			});
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
			const sessionContext = resolveSessionContext(ctx);
			const rememberedParentSession = sessionContext.behavior.kind === "subagent"
				? sessionContext.runtimeParentSessionFile
				: sessionContext.sessionFile;
			const taskList = params.tasks?.length
				? params.tasks
				: params.thread && params.action
					? [{ thread: params.thread, action: params.action }]
					: null;

			if (!taskList) {
				return {
					content: [{ type: "text", text: "Provide either thread+action (single) or tasks array (batch)." }],
					details: { mode: "single" as const, items: [] },
					isError: true,
				};
			}

			const releaseActiveParentDispatch = trackActiveParentDispatch(
				sessionContext.sessionFile,
				sessionContext.behavior.kind,
			);

			try {
				const mode = taskList.length > 1 ? "batch" : "single";
				const taskSessionPaths = new Map(taskList.map((task) => [task.thread, getThreadSessionPath(ctx.cwd, task.thread)]));
				const allItems: (SingleDispatchResult | null)[] = taskList.map(() => null);

				const emitBatchUpdate = () => {
					if (!onUpdate) return;
					const currentItems = allItems.filter((i): i is SingleDispatchResult => i !== null);
					if (currentItems.length === 0) return;
					onUpdate({
						content: [{ type: "text", text: currentItems.map((i) => `[${i.thread}] ${i.episode || "(running...)"}`).join("\n\n") }],
						details: { mode, items: currentItems },
					});
				};

				if (rememberedParentSession) {
					for (const task of taskList) {
						const sessionPath = taskSessionPaths.get(task.thread);
						if (!sessionPath) continue;
						rememberRuntimeSubagent(rememberedParentSession, task.thread, sessionPath);
					}
				}

				const runOne = async (task: { thread: string; action: string }, index: number): Promise<SingleDispatchResult> => {
					const episodeNumber = (episodeCounts.get(task.thread) || 0) + 1;
					const taskOnUpdate = mode === "single"
						? onUpdate
						: onUpdate
							? (partial: AgentToolResult<DispatchDetails>) => {
									const inProgress = partial.details?.items?.[0];
									if (inProgress) allItems[index] = inProgress;
									emitBatchUpdate();
								}
							: undefined;

					const sessionPath = taskSessionPaths.get(task.thread) ?? getThreadSessionPath(ctx.cwd, task.thread);

					const pendingItem: SingleDispatchResult = {
						thread: task.thread,
						action: task.action,
						episode: "(running...)",
						episodeNumber,
						result: createEmptyThreadActionResult({
							thread: task.thread,
							action: task.action,
							model,
							sessionPath,
							isNewThread: !fs.existsSync(sessionPath),
						}),
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

				const items = await Promise.all(taskList.map((task, index) => runOne(task, index)));
				const anyError = items.some(({ result }) =>
					result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted",
				);
				const contentText = items.map((i) => `[${i.thread}] ${i.episode}`).join("\n\n");

				return {
					content: [{ type: "text", text: contentText }],
					details: { mode, items },
					isError: anyError ? true : undefined,
				};
			} finally {
				releaseActiveParentDispatch();
			}
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

		renderResult(result, _controls, theme) {
			const details = result.details as DispatchDetails | undefined;

			if (!details || details.items.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			return new Text(details.items.map((item) => summarizeDispatchItem(item, theme)).join("\n\n"), 0, 0);
		},
	});
}
