/**
 * @mention Talk-to-Thread — direct messaging to threads
 *
 * Intercepts user input matching `@threadname message` and dispatches
 * the message directly to the named thread, bypassing the orchestrator.
 * The thread's response is displayed as a custom message.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text } from "@mariozechner/pi-tui";

import type { ThreadRegistry } from "../state.ts";
import {
	listThreads,
	getThreadSessionPath,
	ensureThreadsDir,
	writeTempFile,
	cleanupTemp,
} from "../helpers.ts";
import { runPiOnThread } from "../dispatch.ts";
import { THREAD_WORKER_PROMPT } from "../orchestrator.ts";

interface ThreadResponseDetails {
	threadName: string;
	message: string;
	turns: number;
}

export function setupMentions(pi: ExtensionAPI, registry: ThreadRegistry): void {
	// Register custom renderer for thread responses
	pi.registerMessageRenderer<ThreadResponseDetails>("thread-response", (message, options, theme) => {
		const { threadName } = message.details || {} as Partial<ThreadResponseDetails>;
		const name = threadName || "unknown";

		const header = `[${theme.fg("accent", theme.bold(name))}] ${theme.fg("dim", "(direct)")}`;

		const content = typeof message.content === "string"
			? message.content
			: (message.content || [])
				.filter((p): p is { type: "text"; text: string } => p.type === "text")
				.map((p) => p.text)
				.join("\n") || "(no content)";

		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Markdown(content, 2, 0, getMarkdownTheme()));
		return container;
	});

	// Intercept @threadname messages
	pi.on("input", async (event, ctx) => {
		const text = event.text;

		// Pattern: @threadname message
		if (!text.startsWith("@")) return { action: "continue" };

		const spaceIdx = text.indexOf(" ");
		if (spaceIdx === -1) return { action: "continue" };

		const threadName = text.slice(1, spaceIdx);
		// Validate thread name is a safe identifier (letters, numbers, hyphens, dots, underscores)
		if (!/^[\w.-]+$/.test(threadName)) return { action: "continue" };
		const message = text.slice(spaceIdx + 1).trim();

		if (!threadName || !message) return { action: "continue" };

		// Check if the thread exists
		const threads = listThreads(ctx.cwd);
		if (!threads.includes(threadName)) {
			// Not a known thread — let it pass through
			return { action: "continue" };
		}

		// Check if the thread is busy
		if (registry.runningThreads.has(threadName)) {
			ctx.ui.notify(`Thread "${threadName}" is currently busy`, "warning");
			return { action: "handled" };
		}

		// Mark running *before* the fire-and-forget so check-and-mark is atomic
		registry.markRunning(threadName);

		// Fire and forget the actual work
		doThreadWork(pi, registry, ctx.cwd, threadName, message).catch((e) => {
			console.error(`@${threadName} mention failed:`, e);
			ctx.ui.notify(`@${threadName} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			registry.markDone(threadName);
		});

		return { action: "handled" };
	});
}

async function doThreadWork(
	pi: ExtensionAPI,
	registry: ThreadRegistry,
	cwd: string,
	threadName: string,
	message: string,
): Promise<void> {
	ensureThreadsDir(cwd);
	const sessionPath = getThreadSessionPath(cwd, threadName);

	// Write thread worker prompt to temp file
	const promptTmp = writeTempFile("worker", THREAD_WORKER_PROMPT);

	try {
		const result = await runPiOnThread(
			cwd,
			sessionPath,
			message,
			registry.subagentModel,
			registry.subagentThinking,
			promptTmp.filePath,
			undefined, // signal
		);

		const lastMsg = result.messages
			.filter((m) => m.role === "assistant")
			.pop();
		const text = lastMsg?.content
			?.find((p: { type: string; text?: string }) => p.type === "text")
			?.text || "(no response)";

		pi.sendMessage<ThreadResponseDetails>({
			customType: "thread-response",
			content: text,
			display: true,
			details: {
				threadName,
				message,
				turns: result.messages.length,
			},
		}, { triggerTurn: false });
	} catch (e: unknown) {
		pi.sendMessage<ThreadResponseDetails>({
			customType: "thread-response",
			content: `Error talking to thread "${threadName}": ${e instanceof Error ? e.message : String(e)}`,
			display: true,
			details: {
				threadName,
				message,
				turns: 0,
			},
		}, { triggerTurn: false });
	} finally {
		registry.markDone(threadName);
		cleanupTemp(promptTmp.dir, promptTmp.filePath);
	}
}
