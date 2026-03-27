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

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type TLiteral, type TUnion } from "@sinclair/typebox";

import type { DispatchDetails, SingleDispatchResult } from "./src/types.ts";
import { listThreads, formatTokens, mapWithConcurrencyLimit, MAX_CONCURRENCY, recordThreadName } from "./src/helpers.ts";
import { ORCHESTRATOR_PROMPT } from "./src/orchestrator.ts";
import { ThreadRegistry } from "./src/state.ts";
import { runThreadAction, buildEpisode, isRetryableFailure } from "./src/dispatch.ts";
import { renderCall, renderResult } from "./src/render.ts";
import { registerCommands, updateStatusBar, loadGlobalConfig } from "./src/commands.ts";
import { setupWidget } from "./src/ui/widget.ts";
import { setupMentions } from "./src/ui/mentions.ts";
import { setupThreadManager } from "./src/ui/thread-manager.ts";

// ─── Extension ───

export default function (pi: ExtensionAPI) {
	const registry = new ThreadRegistry();
	let unsubWidget: (() => void) | undefined;

	// Register all slash commands
	registerCommands(pi, registry);

	// Register @mention talk-to-thread
	setupMentions(pi, registry);

	// Register unified Thread Manager (Ctrl+Alt+T, Ctrl+Shift+T, /threads, /thread-delete)
	setupThreadManager(pi, registry);

	// Shared init logic for session_start and session_switch
	async function initSessionState(ctx: ExtensionContext) {
		registry.clear();
		registry.sessionId = ctx.sessionManager.getSessionId();

		// Restore model/thinking config from session
		let hasSessionConfig = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "thread-config" && entry.data) {
				if (entry.data.model) registry.subagentModel = entry.data.model;
				registry.setThinking(entry.data.thinking);
				hasSessionConfig = true;
			}
		}
		if (!hasSessionConfig) {
			const globalConfig = await loadGlobalConfig();
			if (globalConfig) {
				if (globalConfig.model) registry.subagentModel = globalConfig.model;
				if (globalConfig.thinking) registry.setThinking(globalConfig.thinking);
			}
		}

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
							registry.updateEpisodeCount(item.thread, item.episodeNumber);
							if (item.result?.usage) {
								const existing = registry.threadStats.get(item.thread);
								registry.updateThreadStats(item.thread, {
									contextTokens: item.result.usage.contextTokens || 0,
									lastCompactedAt: item.result.compaction ? (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()) : (existing?.lastCompactedAt || 0),
									compactionCount: (existing?.compactionCount || 0) + (item.result.compaction ? 1 : 0),
								});
							}
						}
					}
				}
			}
		}

		// Backfill thread name index for existing threads
		const knownThreadNames = new Set<string>([
			...registry.episodeCounts.keys(),
			...registry.threadStats.keys(),
			...registry.lastActivity.keys(),
		]);
		for (const name of knownThreadNames) {
			await recordThreadName(ctx.cwd, registry.sessionId, name).catch(() => {});
		}

		ctx.ui.notify("🧵 Thread orchestrator active", "info");
		updateStatusBar(ctx, registry);
		unsubWidget?.();
		unsubWidget = setupWidget(registry, ctx);
	}

	// Reconstruct state on session load
	pi.on("session_start", async (_event, ctx) => {
		await initSessionState(ctx);
	});

	// Re-init state when switching to an existing session (e.g. /resume)
	pi.on("session_switch", async (_event, ctx) => {
		await initSessionState(ctx);
	});

	// Re-init state when forking/branching a session
	pi.on("session_fork", async (_event, ctx) => {
		await initSessionState(ctx);
	});

	// Inject orchestrator system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		let extra = ORCHESTRATOR_PROMPT;

		// Tell the orchestrator about existing threads
		const threads = await listThreads(ctx.cwd, registry.sessionId);
		if (threads.length > 0) {
			const threadInfo = threads.map((t) => {
				const count = registry.episodeCounts.get(t) || 0;
				const stats = registry.threadStats.get(t);
				const contextInfo = stats?.contextTokens ? `, ${formatTokens(stats.contextTokens)} context` : "";
				const compactInfo = stats?.compactionCount ? `, compacted ${stats.compactionCount}×` : "";
				return `  - **${t}** (${count} episode${count !== 1 ? "s" : ""}${contextInfo}${compactInfo})`;
			});
			extra += `\n## Active Threads\n${threadInfo.join("\n")}\n`;
		}

		extra += `\n## Current Subagent Model\n${registry.subagentModel}\n`;
		extra += `\n## Current Subagent Thinking\n${registry.subagentThinking || "(pi default from settings)"}\n`;

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
			thinking: Type.Optional(Type.Union(
				[Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")],
				{ description: "Thinking level: off, minimal, low, medium, high, xhigh" }
			)),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						thread: Type.String({ description: "Thread name" }),
						action: Type.String({ description: "Action for this thread" }),
						thinking: Type.Optional(Type.Union(
							[Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")],
							{ description: "Thinking level: off, minimal, low, medium, high, xhigh" }
						)),
					}),
					{ description: "Batch mode: thread actions dispatched in parallel." },
				),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = registry.subagentModel;
			const defaultThinking = registry.subagentThinking;

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
				const episodeNumber = (registry.episodeCounts.get(task.thread) || 0) + 1;

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
				registry.markRunning(task.thread);
				let result;
				let retried = false;
				let firstAttemptError: string | undefined;
				try {
					result = await runThreadAction(
						ctx.cwd, task.thread, task.action, model, thinking, signal,
						taskOnUpdate,
						episodeNumber,
						registry.sessionId,
					);

					// Retry once on retryable transient failures
					if (isRetryableFailure(result, signal) && !signal.aborted) {
						// Capture first attempt failure info
						firstAttemptError = [
							result.errorMessage ? `Error: ${result.errorMessage}` : "",
							result.stderr ? `Stderr: ${result.stderr.trim().slice(-300)}` : "",
							`Exit code: ${result.exitCode}`,
						].filter(Boolean).join("; ");

						onUpdate?.({
							content: [{ type: "text", text: `Transient failure detected, retrying thread [${task.thread}] in 2s...\n${firstAttemptError}` }],
							details: { mode: "single", items: [] },
						});

						await new Promise<void>(r => {
							const timer = setTimeout(r, 2000);
							// Allow abort to cancel the wait
							if (signal) {
								const onAbort = () => {
									clearTimeout(timer);
									r();
								};
								signal.addEventListener("abort", onAbort, { once: true });
							}
						});

						if (!signal.aborted) {
							retried = true;
							registry.markRunning(task.thread);
							result = await runThreadAction(
								ctx.cwd, task.thread, task.action, model, thinking, signal,
								taskOnUpdate,
								episodeNumber,
								registry.sessionId,
							);
						}
					}
				} finally {
					registry.markDone(task.thread);
				}

				// Track error state
				if (result.errorMessage || result.exitCode !== 0) {
					registry.markError(task.thread);
				} else {
					registry.clearError(task.thread);
				}

				// Build episode directly — tool call history + last message + error context, no extra model call
				const episode = buildEpisode(
					result.messages,
					result.compaction,
					result.stderr,
					result.exitCode,
					result.errorMessage,
					retried ? firstAttemptError : undefined,
				);
				registry.setEpisodeCount(task.thread, episodeNumber);

				// Update thread context stats
				const existingStats = registry.threadStats.get(task.thread);
				const updatedStats = {
					contextTokens: result.usage.contextTokens,
					lastCompactedAt: existingStats?.lastCompactedAt || 0,
					compactionCount: existingStats?.compactionCount || 0,
				};
				if (result.compaction) {
					updatedStats.lastCompactedAt = Date.now();
					updatedStats.compactionCount++;
				}
				registry.updateThreadStats(task.thread, updatedStats);

				const item: SingleDispatchResult = { thread: task.thread, action: task.action, episode, episodeNumber, result };
				allItems[index] = item;
				if (mode === "batch") emitBatchUpdate();
				return item;
			};

			let items: SingleDispatchResult[];
			if (taskList.length === 1) {
				items = [await runOne(taskList[0], 0)];
			} else {
				items = await mapWithConcurrencyLimit(taskList, MAX_CONCURRENCY, (t, i) => runOne(t, i));
			}

			const anyError = items.some(
				(i) => i.result.exitCode !== 0 || i.result.stopReason === "error" || i.result.stopReason === "aborted",
			);

			const contentText = items.map((i) => `[${i.thread}] ${i.episode}`).join("\n\n");

			// NOTE: `isError` is returned but pi's tool execution pipeline may silently
			// ignore it. To reliably signal errors to the model, the episode text itself
			// should contain clear error descriptions. Throwing would alter control flow
			// (abort remaining batch items), so we keep the current return-based approach.
			return {
				content: [{ type: "text", text: contentText }],
				details: { mode, items },
				isError: anyError ? true : undefined,
			};
		},

		// ─── Rendering ───

		renderCall(args, theme, context) {
			return renderCall(args, theme);
		},

		renderResult(result, opts, theme, context) {
			return renderResult(result, opts, theme);
		},
	});
}
