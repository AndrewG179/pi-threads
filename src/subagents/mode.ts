import * as path from "node:path";

import type { ThreadsState } from "./state";

export type SessionBehaviorKind = "normal" | "orchestrator" | "subagent";

export interface SessionBehavior {
	kind: SessionBehaviorKind;
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

	if (parentSessionFile) {
		return {
			kind: "subagent",
			shouldAppendOrchestratorPrompt: false,
			parentSessionFile,
		};
	}

	if (input.state.enabled && !isThreadSession) {
		return {
			kind: "orchestrator",
			shouldAppendOrchestratorPrompt: true,
		};
	}

	return {
		kind: "normal",
		shouldAppendOrchestratorPrompt: false,
	};
}

export function resolveActiveToolsForBehavior(
	behaviorKind: SessionBehaviorKind,
	currentActiveTools: string[],
	allTools: ReadonlyArray<string | { name: string }>,
): string[] {
	if (behaviorKind !== "orchestrator") {
		return [...currentActiveTools];
	}

	const blocked = new Set(BUILTIN_FILE_SHELL_TOOLS);
	return allTools
		.map(extractToolName)
		.filter((toolName) => !blocked.has(toolName));
}

