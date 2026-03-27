import { spawn } from "node:child_process";
import * as fs from "node:fs";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

import type { DispatchDetails, ThreadActionResult } from "./types.ts";
import { THREAD_WORKER_PROMPT } from "./orchestrator.ts";
import {
	ensureThreadsDir,
	recordThreadName,
	getThreadSessionPath,
	getPiInvocation,
	writeTempFile,
	cleanupTemp,
	formatTokens,
} from "./helpers.ts";

// ─── Retry Helper ───

/** Transient error patterns that are safe to retry */
const TRANSIENT_PATTERNS = [
	/ECONNREFUSED/i,
	/ECONNRESET/i,
	/ETIMEDOUT/i,
	/ENETUNREACH/i,
	/socket hang up/i,
	/rate limit/i,
	/429/,
	/503/,
	/too many requests/i,
	/spawn.*ENOENT/i,
	/network/i,
];

/**
 * Determine if a thread action result represents a retryable transient failure.
 * Only retries on network/transient errors. Never retries user cancellation
 * or deterministic failures that could have side effects.
 */
export function isRetryableFailure(result: ThreadActionResult, signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;
	// Only retry if we can identify a transient error pattern
	const errorText = [result.stderr ?? "", result.errorMessage ?? ""].join(" ");
	if (errorText && TRANSIENT_PATTERNS.some(p => p.test(errorText))) return true;
	// If the process couldn't even spawn (no messages captured), treat as transient
	if (result.exitCode !== 0 && result.messages.length === 0) return true;
	return false;
}

// ─── Thread Execution ───

/**
 * Run a pi process against a thread session. Used for both the action
 * and the episode extraction (same session = cached context).
 */
export async function runPiOnThread(
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

	const invocation = await getPiInvocation(args);
	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";

		interface PiStreamEvent {
			type?: string;
			message?: Message;
			result?: { tokensBefore?: number; tokensAfter?: number };
		}

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: PiStreamEvent;
			try {
				event = JSON.parse(line) as PiStreamEvent;
			} catch {
				// Malformed JSON line from subprocess — skip silently
				// (partial lines are buffered and retried, only truly broken lines land here)
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

		proc.on("error", (err) => {
			stderr += `Spawn error: ${err.message}\n`;
			resolve(1);
		});

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

export async function runThreadAction(
	cwd: string,
	threadName: string,
	action: string,
	model: string | undefined,
	thinking: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<DispatchDetails>) => void) | undefined,
	episodeNumber: number,
	sessionId: string,
): Promise<ThreadActionResult> {
	await ensureThreadsDir(cwd, sessionId);
	await recordThreadName(cwd, sessionId, threadName);
	const sessionPath = getThreadSessionPath(cwd, sessionId, threadName);
	const sessionExists = await fs.promises.access(sessionPath).then(() => true).catch(() => false);
	const isNewThread = !sessionExists;

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
	const promptTmp = await writeTempFile("worker", THREAD_WORKER_PROMPT);

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
		await cleanupTemp(promptTmp.dir, promptTmp.filePath);
	}
}

// ─── Episode Generation ───

export function getFinalOutput(messages: Message[]): string {
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
 * Build the episode directly from thread output — no extra model call.
 * Returns: tool call history + last assistant message + error context if any.
 * The orchestrator sees exactly what the thread did and said.
 */
export function buildEpisode(
	messages: Message[],
	compaction?: { tokensBefore: number; tokensAfter: number },
	stderr?: string,
	exitCode?: number,
	errorMessage?: string,
	firstAttemptError?: string,
): string {
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

	// Part 3: Error context — surface failures to the orchestrator
	if (exitCode !== undefined && exitCode !== 0 && stderr && stderr.trim()) {
		parts.push(`\nERROR (exit ${exitCode}): ${stderr.trim().slice(-500)}`);
	}
	if (errorMessage) {
		parts.push(`\nERROR: ${errorMessage}`);
	}
	if (firstAttemptError) {
		parts.push(`\nRETRY CONTEXT: ${firstAttemptError}`);
	}

	return parts.join("\n") || "(no output)";
}
