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
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, DynamicBorder, Text, createSearchInput, truncateToWidth, visibleWidth } from "./src/pi/runtime-deps";

import {
	collectCompletedDispatchItems,
	rebuildEpisodeCounts as rebuildDispatchEpisodeCounts,
} from "./src/dispatch/history";
import {
	createEmptyThreadActionResult,
	type DispatchTask,
	findDuplicateThreads,
	getDispatchFailureSummary,
	getThreadsDir,
	resolveDispatchSessionPath,
	type DispatchDetails,
	type SingleDispatchResult,
	type UsageStats,
} from "./src/dispatch/contract";
import { runThreadAction } from "./src/dispatch/runner";
import { buildEpisode as buildThreadEpisode } from "./src/episode/builder";
import { PiActorRuntime } from "./src/runtime/pi-actor";
import { getThreadSessionPath, normalizeSessionPath, toSubagentStatus } from "./src/subagents/metadata";
import {
	buildSubagentModelPromptSection,
	buildSubagentModelStatusText,
	findFuzzyModelMatches,
	formatModelIdentifier,
	getAvailableModels,
	isModelOverrideResetQuery,
	resolveEffectiveSubagentModel,
	toModelDescriptor,
	type ModelDescriptor,
	type ModelLike,
} from "./src/subagents/model-selection";
import { deriveSessionBehavior, resolveActiveToolsForBehavior } from "./src/subagents/mode";
import { SubagentRunStore } from "./src/subagents/runtime-store";
import { loadThreadsState, saveThreadsState } from "./src/subagents/state";
import { SubagentBrowser } from "./src/subagents/view";
import { wrapText } from "./src/text/wrap";

// ─── Constants ───

const piActorRuntime = new PiActorRuntime();

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

const DISPATCH_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		thread: {
			type: "string",
			description: "Thread name — identifies the work stream. Reuse for related actions. (single mode)",
		},
		action: {
			type: "string",
			description: "Direct, concrete instructions for the thread to execute. (single mode)",
		},
		tasks: {
			type: "array",
			description: "Batch mode: thread actions dispatched in parallel.",
			minItems: 1,
			items: {
				type: "object",
				properties: {
					thread: {
						type: "string",
						description: "Thread name",
					},
					action: {
						type: "string",
						description: "Action for this thread",
					},
				},
				required: ["thread", "action"],
				additionalProperties: false,
			},
		},
	},
	additionalProperties: false,
} as const;

function listThreadSessionNames(cwd: string): string[] {
	const dir = getThreadsDir(cwd);
	if (!fs.existsSync(dir)) return [];
	try {
		return fs
			.readdirSync(dir)
			.filter((fileName) => fileName.endsWith(".jsonl"))
			.map((fileName) => fileName.replace(/\.jsonl$/, ""));
	} catch {
		return [];
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

// ─── Rendering Helpers ───

function wrapDispatchSummaryText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	return wrapText(text, safeWidth, { minWidth: 1 }).map((line) => truncateToWidth(line, safeWidth));
}

function renderDispatchItemSummary(item: SingleDispatchResult, theme: any, width: number): string[] {
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
		lines.push(...wrapDispatchSummaryText(summaryText, width));
	}
	if (isError && result.errorMessage) {
		lines.push(...wrapDispatchSummaryText(result.errorMessage, width).map((line) => theme.fg("error", line)));
	}
	const usage = formatUsage(result.usage);
	if (usage) {
		lines.push(theme.fg("dim", usage));
	}
	return lines;
}

class DispatchSummaryText extends Text {
	constructor(
		private readonly items: SingleDispatchResult[],
		private readonly theme: any,
	) {
		super("", 0, 0);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const [index, item] of this.items.entries()) {
			if (index > 0) lines.push("");
			lines.push(...renderDispatchItemSummary(item, this.theme, width));
		}
		return lines.length > 0 ? lines : [""];
	}
}

// ─── Extension ───

export default function (pi: ExtensionAPI) {
	// Track episode counts per canonical worker session path.
	const episodeCounts = new Map<string, number>();
	let defaultActiveTools: string[] | null = null;
	let subagentModelOverride: ModelDescriptor | undefined;
	const subagentRunStore = new SubagentRunStore();

	const arraysEqual = (left: string[], right: string[]) =>
		left.length === right.length && left.every((value, index) => value === right[index]);

	const getParentSessionModel = (ctx: { model?: ModelLike }) => toModelDescriptor(ctx.model);

	const getEffectiveSubagentModel = (ctx: { model?: ModelLike }): string | undefined =>
		resolveEffectiveSubagentModel(getParentSessionModel(ctx), subagentModelOverride);

	const updateSubagentModelStatus = (ctx: {
		ui?: { theme?: { fg?: (color: string, text: string) => string }; setStatus?: (key: string, text: string | undefined) => void };
		model?: ModelLike;
	}) => {
		const statusText = buildSubagentModelStatusText(getParentSessionModel(ctx), subagentModelOverride);
		ctx.ui?.setStatus?.(
			"subagent-model",
			ctx.ui?.theme?.fg ? ctx.ui.theme.fg("dim", statusText) : statusText,
		);
	};

	const setSubagentModelOverride = (nextModel: ModelDescriptor | undefined, ctx: {
		ui?: {
			notify?: (message: string, level?: string) => void;
			theme?: { fg?: (color: string, text: string) => string };
			setStatus?: (key: string, text: string | undefined) => void;
		};
		model?: ModelLike;
	}) => {
		subagentModelOverride = nextModel;
		updateSubagentModelStatus(ctx);
		if (nextModel) {
			ctx.ui?.notify?.(`Subagent model override set to ${formatModelIdentifier(nextModel)}.`, "info");
			return;
		}
		ctx.ui?.notify?.("Subagent model override cleared. Workers will inherit the current session model.", "info");
	};

	const getCanonicalThreadSessionPath = (cwd: string, thread: string, sessionPath?: string) =>
		resolveDispatchSessionPath(cwd, thread, sessionPath);

	const rebuildEpisodeCounts = (
		cwd: string,
		sessionManager: { getBranch(): Array<{ type: string; message: { role: string; toolName?: string; details?: unknown } }> },
	) => {
		rebuildDispatchEpisodeCounts(episodeCounts, collectCompletedDispatchItems(cwd, sessionManager.getBranch()));
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
		return { behavior, sessionFile };
	};

	const syncSessionMode = (ctx: {
		hasUI?: boolean;
		cwd: string;
		sessionManager: { getSessionFile(): string | undefined; getBranch(): Array<{ type: string; message: { role: string; toolName?: string; details?: unknown } }> };
		ui: {
			theme: any;
			setStatus: (key: string, text: string | undefined) => void;
			setWidget: (key: string, content: unknown, options?: unknown) => void;
		};
	}) => {
		const { behavior } = resolveSessionContext(ctx);
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

		if (behavior.kind === "orchestrator") {
			ctx.ui.setStatus("pi-threads", ctx.ui.theme.fg("accent", "threads:on"));
		} else if (behavior.kind === "subagent") {
			ctx.ui.setStatus("pi-threads", ctx.ui.theme.fg("warning", `subagent:${behavior.threadName ?? "thread"}`));
		} else {
			ctx.ui.setStatus("pi-threads", undefined);
		}
		updateSubagentModelStatus(ctx);

		rebuildEpisodeCounts(ctx.cwd, ctx.sessionManager);
		return behavior;
	};

	const reconcileCompletedSubagentHistory = (
		parentSessionFile: string | undefined,
		cwd: string,
		parentBranchEntries: Array<{ type: string; message: { role: string; toolName?: string; details?: unknown } }>,
	) => {
		if (!parentSessionFile) return;
		subagentRunStore.seedCompletedFromParent(parentSessionFile, collectCompletedDispatchItems(cwd, parentBranchEntries));
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
	}) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("The /subagents browser requires the interactive UI.", "warning");
			return;
		}

		const { sessionFile } = resolveSessionContext(ctx);
		if (!sessionFile) {
			ctx.ui.notify("Current session is not persisted, so /subagents has no session-scoped run store yet.", "warning");
			return;
		}
		reconcileCompletedSubagentHistory(sessionFile, ctx.cwd, ctx.sessionManager.getBranch());

		await ctx.ui.custom<void | undefined>(
			(tui, theme, keybindings, done) =>
				new SubagentBrowser(() => subagentRunStore.getCards(sessionFile), tui, theme, keybindings, done),
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
	};

	const openSubagentModelPicker = async (ctx: {
		hasUI: boolean;
		model?: ModelLike;
		modelRegistry?: { getAvailable: () => Promise<readonly ModelLike[]> | readonly ModelLike[] };
		ui: {
			notify: (message: string, level?: string) => void;
			custom<T>(
				factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => unknown,
				options?: unknown,
			): Promise<T>;
		};
	}, initialQuery: string): Promise<ModelDescriptor | undefined | null> => {
		const models = await getAvailableModels(ctx.modelRegistry);
		if (models.length === 0) {
			ctx.ui.notify("No subagent models with configured API keys are available.", "warning");
			return null;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("The /model-sub picker requires the interactive UI. Use /model-sub provider/model or /model-sub inherit.", "warning");
			return null;
		}

		const BorderComponent = DynamicBorder;
		const parentModel = getParentSessionModel(ctx);
		const currentOverrideRef = subagentModelOverride ? formatModelIdentifier(subagentModelOverride) : undefined;
		const sortedModels = [...models].sort((left, right) => {
			const leftRef = formatModelIdentifier(left);
			const rightRef = formatModelIdentifier(right);
			const leftIsCurrent = currentOverrideRef !== undefined && leftRef === currentOverrideRef;
			const rightIsCurrent = currentOverrideRef !== undefined && rightRef === currentOverrideRef;
			if (leftIsCurrent && !rightIsCurrent) return -1;
			if (!leftIsCurrent && rightIsCurrent) return 1;
			return leftRef.localeCompare(rightRef);
		});

		const choice = await ctx.ui.custom<ModelDescriptor | undefined | null>((tui, theme, keybindings, done) => {
			const maxVisible = 10;
			let query = initialQuery.trim();
			let filteredModels = query ? findFuzzyModelMatches(sortedModels, query) : sortedModels;
			let selectedIndex = 0;
			const searchInput = createSearchInput(theme, query);
			const container = new Container();
			const headerText = new Text(theme.fg("accent", theme.bold("Subagent model override")), 0, 0);
			const hintText = new Text(
				theme.fg("muted", "Workers inherit the current session model by default. Pick a model to force an override."),
				0,
				0,
			);
			const searchLabel = new Text(theme.fg("muted", "Search:"), 0, 0);
			const listText = new Text("", 0, 0);
			const detailText = new Text("", 0, 0);
			const footerText = new Text(theme.fg("dim", "selection keys move • confirm selects • cancel closes"), 0, 0);

			container.addChild(new BorderComponent((text: string) => theme.fg("accent", text)));
			container.addChild(headerText);
			container.addChild(hintText);
			container.addChild(new Text("", 0, 0));
			container.addChild(searchLabel);
			container.addChild(searchInput);
			container.addChild(new Text("", 0, 0));
			container.addChild(listText);
			container.addChild(new Text("", 0, 0));
			container.addChild(detailText);
			container.addChild(new Text("", 0, 0));
			container.addChild(footerText);
			container.addChild(new BorderComponent((text: string) => theme.fg("accent", text)));

			const shouldShowInheritOption = (value: string) =>
				value.length === 0
				|| isModelOverrideResetQuery(value)
				|| ["inherit", "current", "default", "parent"].some((token) => token.includes(value.toLowerCase()));

			const getItems = () => {
				const items: Array<{ kind: "inherit" } | { kind: "model"; model: ModelDescriptor }> = [];
				if (shouldShowInheritOption(query)) {
					items.push({ kind: "inherit" });
				}
				for (const model of filteredModels) {
					items.push({ kind: "model", model });
				}
				return items;
			};

			const applyFilter = () => {
				query = searchInput.getValue().trim();
				filteredModels = query ? findFuzzyModelMatches(sortedModels, query) : sortedModels;
				selectedIndex = Math.min(selectedIndex, Math.max(0, getItems().length - 1));
			};

			const renderList = () => {
				const items = getItems();
				if (items.length === 0) {
					listText.setText(theme.fg("warning", "No matching models"));
					detailText.setText(theme.fg("muted", "Try a broader search or use an exact provider/model identifier."));
					return;
				}

				let startIndex = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
				if (startIndex + maxVisible > items.length) {
					startIndex = Math.max(0, items.length - maxVisible);
				}
				const endIndex = Math.min(startIndex + maxVisible, items.length);
				const lines: string[] = [];

				for (let index = startIndex; index < endIndex; index++) {
					const item = items[index]!;
					const isSelected = index === selectedIndex;
					if (item.kind === "inherit") {
						const active = subagentModelOverride === undefined ? theme.fg("success", " ✓") : "";
						const label = parentModel
							? `inherit current session model (${formatModelIdentifier(parentModel)})`
							: "inherit current session model";
						lines.push(
							isSelected
								? theme.fg("accent", `→ ${label}`) + active
								: `  ${label}${active}`,
						);
						continue;
					}

					const ref = formatModelIdentifier(item.model);
					const active = currentOverrideRef === ref ? theme.fg("success", " ✓") : "";
					const label = `${item.model.id} ${theme.fg("muted", `[${item.model.provider}]`)}`;
					lines.push(
						isSelected
							? theme.fg("accent", `→ ${item.model.id}`) + ` ${theme.fg("muted", `[${item.model.provider}]`)}${active}`
							: `  ${label}${active}`,
					);
				}

				if (items.length > maxVisible) {
					lines.push(theme.fg("muted", `(${selectedIndex + 1}/${items.length})`));
				}
				listText.setText(lines.join("\n"));

				const selected = items[selectedIndex]!;
				if (selected.kind === "inherit") {
					detailText.setText(
						theme.fg(
							"muted",
							parentModel
								? `Clear the explicit override and inherit ${formatModelIdentifier(parentModel)} from this session.`
								: "Clear the explicit override and inherit whatever model this session is currently using.",
						),
					);
					return;
				}

				detailText.setText(
					theme.fg(
						"muted",
						selected.model.name
							? `${formatModelIdentifier(selected.model)} — ${selected.model.name}`
							: formatModelIdentifier(selected.model),
					),
				);
			};

			applyFilter();
			renderList();

			let focused = true;
			searchInput.focused = true;
			const matchesCommand = (input: string, command: string, fallbacks: readonly string[]) => {
				if (keybindings && typeof keybindings.matches === "function") {
					return keybindings.matches(input, command);
				}
				return fallbacks.includes(input);
			};

			return {
				get focused() {
					return focused;
				},
				set focused(value: boolean) {
					focused = value;
					searchInput.focused = value;
				},
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					const items = getItems();
					if (matchesCommand(data, "tui.select.up", ["\x1b[A", "\x1bOA"]) && items.length > 0) {
						selectedIndex = selectedIndex <= 0 ? items.length - 1 : selectedIndex - 1;
						renderList();
						tui.requestRender();
						return;
					}
					if (matchesCommand(data, "tui.select.down", ["\x1b[B", "\x1bOB"]) && items.length > 0) {
						selectedIndex = selectedIndex >= items.length - 1 ? 0 : selectedIndex + 1;
						renderList();
						tui.requestRender();
						return;
					}
					if (matchesCommand(data, "tui.select.confirm", ["\r", "\n"]) && items.length > 0) {
						const selected = items[selectedIndex]!;
						done(selected.kind === "inherit" ? undefined : selected.model);
						return;
					}
					if (matchesCommand(data, "tui.select.cancel", ["\x1b", "\x03"])) {
						done(null);
						return;
					}
					searchInput.handleInput(data);
					applyFilter();
					renderList();
					tui.requestRender();
				},
			};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-center",
					width: "70%",
					minWidth: 60,
					maxHeight: "80%",
					margin: 1,
				},
			},
		);

		return choice;
	};

	// Reconstruct state on session load
	pi.on("session_start", async (_event, ctx) => {
		syncSessionMode(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		syncSessionMode(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateSubagentModelStatus(ctx);
	});

	// Inject orchestrator system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		const { behavior } = resolveSessionContext(ctx);
		if (behavior.kind !== "orchestrator") return;

		let extra = ORCHESTRATOR_PROMPT;

		// Tell the orchestrator about existing threads
		const threadSessions = listThreadSessionNames(ctx.cwd);
		if (threadSessions.length > 0) {
			const threadInfo = threadSessions.map((threadName) => {
				const count = episodeCounts.get(getCanonicalThreadSessionPath(ctx.cwd, threadName)) || 0;
				return `  - **${threadName}** (${count} episode${count !== 1 ? "s" : ""})`;
			});
			extra += [
				"",
				"## Known Worker Sessions on Disk",
				"These are existing `.pi/threads/*.jsonl` session files. They are not necessarily running right now or scoped to the current parent session.",
				threadInfo.join("\n"),
				"",
			].join("\n");
		}

		extra += `\n${buildSubagentModelPromptSection(getParentSessionModel(ctx), subagentModelOverride)}\n`;

		return { systemPrompt: event.systemPrompt + extra };
	});

	pi.registerCommand("threads", {
		description: "Turn thread orchestrator mode on or off for this project",
		getArgumentCompletions(prefix) {
			const values = ["on", "off"].filter((value) => value.startsWith(prefix));
			return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
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

	pi.registerCommand("subagents", {
		description: "Browse live subagent runs for the current session",
		handler: async (_args, ctx) => {
			await openSubagentsBrowser(ctx);
		},
	});

	pi.registerCommand("model-sub", {
		description: "Set or clear the worker model override used for dispatched subagents",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (isModelOverrideResetQuery(input)) {
				setSubagentModelOverride(undefined, ctx);
				return;
			}

			if (input.includes("/")) {
				const slashIndex = input.indexOf("/");
				const provider = input.slice(0, slashIndex).trim();
				const id = input.slice(slashIndex + 1).trim();
				if (provider && id) {
					setSubagentModelOverride({ provider, id }, ctx);
					return;
				}
			}

			const availableModels = await getAvailableModels((ctx as {
				modelRegistry?: { getAvailable: () => Promise<readonly ModelLike[]> | readonly ModelLike[] };
			}).modelRegistry);
			if (input) {
				const matches = findFuzzyModelMatches(availableModels, input);
				if (matches.length === 1) {
					setSubagentModelOverride(matches[0], ctx);
					return;
				}
				if (!ctx.hasUI) {
					if (matches.length > 1) {
						ctx.ui?.notify?.(
							`Multiple subagent models match \"${input}\": ${matches.slice(0, 5).map((model) => formatModelIdentifier(model)).join(", ")}. Use an exact provider/model string.`,
							"warning",
						);
						return;
					}
					ctx.ui?.notify?.(
						"No matching configured subagent models were found. Use an exact provider/model string or run /model-sub in the interactive UI.",
						"warning",
					);
					return;
				}
			}

			const choice = await openSubagentModelPicker(ctx as {
				hasUI: boolean;
				model?: ModelLike;
				modelRegistry?: { getAvailable: () => Promise<readonly ModelLike[]> | readonly ModelLike[] };
				ui: {
					notify: (message: string, level?: string) => void;
					custom<T>(
						factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => unknown,
						options?: unknown,
					): Promise<T>;
				};
			}, input);
			if (choice === null) return;
			setSubagentModelOverride(choice, ctx);
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
		parameters: DISPATCH_TOOL_PARAMETERS,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = getEffectiveSubagentModel(ctx);
			const sessionContext = resolveSessionContext(ctx);
			const parentSessionFile = sessionContext.sessionFile;
			const taskList: DispatchTask[] | null = params.tasks?.length
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
			const mode = taskList.length > 1 ? "batch" : "single";
			const threadsDir = getThreadsDir(ctx.cwd);
			const duplicateThreads = mode === "batch" ? findDuplicateThreads(taskList, threadsDir) : [];
			if (duplicateThreads.length > 0) {
				return {
					content: [{
						type: "text",
						text: `Duplicate worker session targets in one batch are not supported: ${duplicateThreads.join(", ")}. These thread names normalize to the same worker session. Split this into separate dispatches or use different thread names.`,
					}],
					details: { mode, items: [] },
					isError: true,
				};
			}
			const taskSessionPaths = new Map(taskList.map((task) => [task.thread, getThreadSessionPath(threadsDir, task.thread)]));
			const allItems: (SingleDispatchResult | null)[] = taskList.map(() => null);
			reconcileCompletedSubagentHistory(parentSessionFile, ctx.cwd, ctx.sessionManager.getBranch());

			const emitBatchUpdate = () => {
				if (!onUpdate) return;
				const currentItems = allItems.filter((i): i is SingleDispatchResult => i !== null);
				if (currentItems.length === 0) return;
				onUpdate({
					content: [{ type: "text", text: currentItems.map((i) => `[${i.thread}] ${i.episode || "(running...)"}`).join("\n\n") }],
					details: { mode, items: currentItems },
				});
			};

			const runOne = async (task: DispatchTask, index: number): Promise<SingleDispatchResult> => {
				const sessionPath = taskSessionPaths.get(task.thread) ?? getThreadSessionPath(threadsDir, task.thread);
				const episodeNumber = (episodeCounts.get(sessionPath) || 0) + 1;
				const taskOnUpdate = mode === "single"
					? onUpdate
					: onUpdate
						? (partial: AgentToolResult<DispatchDetails>) => {
								const inProgress = partial.details?.items?.[0];
								if (inProgress) {
									allItems[index] = inProgress;
								}
								emitBatchUpdate();
							}
						: undefined;

				const runId = `${task.thread}:${episodeNumber}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

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
				if (parentSessionFile) {
					subagentRunStore.startRun({
						parentSessionFile,
						runId,
						thread: task.thread,
						sessionPath,
						action: task.action,
					});
				}
				taskOnUpdate?.({
					content: [{ type: "text", text: "(running...)" }],
					details: { mode: "single", items: [pendingItem] },
				});

				const result = await runThreadAction({
					runtime: piActorRuntime,
					cwd: ctx.cwd,
					threadName: task.thread,
					action: task.action,
					model,
					signal,
					onUpdate: taskOnUpdate,
					episodeNumber,
					runId,
					onRuntimeMessage: (message, liveCost) => {
						if (!parentSessionFile) return;
						subagentRunStore.recordMessage({
							parentSessionFile,
							runId,
							message,
							sessionPath,
							liveCost,
						});
					},
				});

				const episode = buildThreadEpisode(
					result.messages as Parameters<typeof buildThreadEpisode>[0],
					{ emptyFallback: getDispatchFailureSummary(result) },
				);
				episodeCounts.set(result.sessionPath, episodeNumber);

				const item: SingleDispatchResult = { thread: task.thread, action: task.action, episode, episodeNumber, result };
				allItems[index] = item;
				if (parentSessionFile) {
					subagentRunStore.finishRun({
						parentSessionFile,
						runId,
						thread: task.thread,
						sessionPath: result.sessionPath,
						action: task.action,
						episodeNumber,
						status: toSubagentStatus(result),
						usageCost: result.usage.cost,
						messages: result.messages,
					});
				}
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

			return new DispatchSummaryText(details.items, theme);
		},
	});
}
