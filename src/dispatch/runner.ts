import * as fs from "node:fs";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

import type { PiActorRuntime } from "../runtime/pi-actor";
import { getThreadSessionPath } from "../subagents/metadata";
import {
	createEmptyThreadActionResult,
	getThreadsDir,
	type DispatchDetails,
	type ThreadActionResult,
} from "./contract";

const THREAD_WORKER_PROMPT = `You are a thread — an execution worker controlled by an orchestrator.

## Your Role
Execute the instructions given to you. You are the hands, not the brain.

## Rules
1. **Follow instructions precisely.** Do exactly what you're told.
2. **Handle tactical details.** Missing imports, typos, small fixups needed to complete your task — just handle them.
3. **Never make strategic decisions.** If something is ambiguous, if you face a fork where different approaches are possible, or if you encounter something unexpected — STOP and report back. Do not guess.
4. **If you fail, report clearly.** Don't try alternative approaches. Describe what went wrong and what state things are in now.
5. **Be thorough within scope.** Complete all parts of your instructions.`;

interface RunThreadActionParams {
	runtime: PiActorRuntime;
	cwd: string;
	threadName: string;
	action: string;
	model: string | undefined;
	signal: AbortSignal | undefined;
	onUpdate: ((partial: AgentToolResult<DispatchDetails>) => void) | undefined;
	episodeNumber: number;
	runId: string;
	onRuntimeMessage?: (message: Message, liveCost: number) => void;
}

function ensureThreadsDir(cwd: string): void {
	const dir = getThreadsDir(cwd);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function getFinalOutput(messages: readonly Message[]): string {
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

export async function runThreadAction(params: RunThreadActionParams): Promise<ThreadActionResult> {
	const { runtime, cwd, threadName, action, model, signal, onUpdate, episodeNumber, runId, onRuntimeMessage } = params;
	ensureThreadsDir(cwd);
	const sessionPath = getThreadSessionPath(getThreadsDir(cwd), threadName);
	const isNewThread = !fs.existsSync(sessionPath);

	const liveResult = createEmptyThreadActionResult({
		thread: threadName,
		action,
		model,
		sessionPath,
		isNewThread,
	});

	const trackUsage = (msg: Message) => {
		if (msg.role !== "assistant") return;

		liveResult.usage.turns++;
		const usage = msg.usage;
		if (usage) {
			liveResult.usage.input += usage.input || 0;
			liveResult.usage.output += usage.output || 0;
			liveResult.usage.cacheRead += usage.cacheRead || 0;
			liveResult.usage.cacheWrite += usage.cacheWrite || 0;
			liveResult.usage.cost += usage.cost?.total || 0;
			liveResult.usage.contextTokens = usage.totalTokens || 0;
		}
		if (!liveResult.model && msg.model) liveResult.model = msg.model;
		if (msg.stopReason) liveResult.stopReason = msg.stopReason;
		if (msg.errorMessage) liveResult.errorMessage = msg.errorMessage;
	};

	const emitUpdate = () => {
		if (!onUpdate) return;
		const lastText = getFinalOutput(liveResult.messages);
		onUpdate({
			content: [{ type: "text", text: lastText || "(running...)" }],
			details: {
				mode: "single",
				items: [{
					thread: threadName,
					action,
					episode: "(running...)",
					episodeNumber,
					result: liveResult,
				}],
			},
		});
	};

	const handle = runtime.invoke({
		runId,
		thread: threadName,
		cwd,
		action,
		model,
		sessionPath,
		systemPrompt: THREAD_WORKER_PROMPT,
	});
	const abort = () => {
		void handle.cancel();
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	const unsubscribe = handle.subscribe((event) => {
		if (event.type === "message") {
			const threadedMessage = event.message as Message;
			liveResult.messages.push(threadedMessage);
			trackUsage(threadedMessage);
			emitUpdate();
			onRuntimeMessage?.(threadedMessage, liveResult.usage.cost);
		}
		if (event.type === "stderr") {
			liveResult.stderr += event.chunk;
		}
	});

	const runtimeResult = await handle.result.finally(() => {
		unsubscribe();
		signal?.removeEventListener("abort", abort);
	});

	const exitCode = runtimeResult.finalState.exitCode
		?? (
			runtimeResult.finalState.signal
			|| runtimeResult.stopReason === "error"
			|| runtimeResult.stopReason === "aborted"
				? 1
				: 0
		);

	return {
		...liveResult,
		messages: runtimeResult.messages as Message[],
		stderr: runtimeResult.stderr,
		usage: { ...runtimeResult.usage },
		model: runtimeResult.model ?? liveResult.model,
		stopReason: runtimeResult.stopReason,
		errorMessage: runtimeResult.errorMessage,
		exitCode,
	};
}
