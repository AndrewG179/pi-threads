import * as path from "node:path";

import type { ThreadsState } from "./state";

export type SessionBehaviorKind = "normal" | "orchestrator" | "subagent";

export interface SessionBehavior {
	kind: SessionBehaviorKind;
	sessionFile?: string;
	threadName?: string;
	shouldAppendOrchestratorPrompt: boolean;
	parentSessionFile?: string;
}

export interface DeriveSessionBehaviorInput {
	cwd: string;
	sessionFile?: string;
	state: ThreadsState;
}

export const BUILTIN_FILE_SHELL_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;

function normalizeSessionPath(sessionPath: string): string {
	return path.resolve(sessionPath);
}

function isSessionUnderDir(sessionFile: string | undefined, dir: string): boolean {
	if (!sessionFile) return false;
	const resolvedSessionFile = normalizeSessionPath(sessionFile);
	const resolvedDir = normalizeSessionPath(dir);
	const relative = path.relative(resolvedDir, resolvedSessionFile);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function extractToolName(tool: string | { name: string }): string {
	return typeof tool === "string" ? tool : tool.name;
}

export function deriveSessionBehavior(input: DeriveSessionBehaviorInput): SessionBehavior {
	const sessionFile = input.sessionFile ? normalizeSessionPath(input.sessionFile) : undefined;
	const threadsDir = path.join(input.cwd, ".pi", "threads");
	const parentSessionFile = sessionFile ? input.state.parentBySession[sessionFile] : undefined;
	const isThreadSession = isSessionUnderDir(sessionFile, threadsDir);

	if (isThreadSession) {
		return {
			kind: "subagent",
			sessionFile,
			threadName: sessionFile ? path.basename(sessionFile, ".jsonl") : undefined,
			shouldAppendOrchestratorPrompt: false,
			parentSessionFile,
		};
	}

	if (input.state.enabled && !isThreadSession) {
		return {
			kind: "orchestrator",
			sessionFile,
			shouldAppendOrchestratorPrompt: true,
		};
	}

	return {
		kind: "normal",
		sessionFile,
		shouldAppendOrchestratorPrompt: false,
	};
}

export function resolveActiveToolsForBehavior(
	behaviorKind: SessionBehaviorKind,
	currentActiveTools: string[],
	allTools: ReadonlyArray<string | { name: string }>,
): string[] {
	const normalizedAllTools = allTools.map(extractToolName);

	if (behaviorKind !== "orchestrator") {
		const withoutDispatch = currentActiveTools.filter((toolName) => toolName !== "dispatch");
		if (withoutDispatch.length === 0 && currentActiveTools.includes("dispatch")) {
			const preferredInteractiveTools = new Set(["read", "write", "edit", "bash"]);
			return normalizedAllTools.filter(
				(toolName) =>
					preferredInteractiveTools.has(toolName) ||
					(!BUILTIN_FILE_SHELL_TOOLS.includes(toolName as (typeof BUILTIN_FILE_SHELL_TOOLS)[number]) && toolName !== "dispatch"),
			);
		}
		return withoutDispatch;
	}

	const blocked = new Set<string>(BUILTIN_FILE_SHELL_TOOLS);
	const allowed = new Set(currentActiveTools.filter((toolName) => !blocked.has(toolName)));
	if (normalizedAllTools.includes("dispatch")) {
		allowed.add("dispatch");
	}
	return normalizedAllTools.filter((toolName) => allowed.has(toolName));
}
