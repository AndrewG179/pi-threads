import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import {
	deriveSessionBehavior,
	resolveActiveToolsForBehavior,
} from "../../src/subagents/mode";

const BUILTIN_FILE_SHELL_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

test("deriveSessionBehavior keeps normal sessions normal when thread mode is off", () => {
	const cwd = "/tmp/pi-threads-mode-off";
	const sessionFile = path.join(cwd, ".pi", "sessions", "parent.jsonl");

	const behavior = deriveSessionBehavior({
		cwd,
		sessionFile,
		state: { enabled: false, parentBySession: {} },
	});

	assert.equal(behavior.kind, "normal");
	assert.equal(behavior.shouldAppendOrchestratorPrompt, false);
	assert.equal(behavior.parentSessionFile, undefined);
});

test("deriveSessionBehavior treats enabled non-thread sessions as orchestrators", () => {
	const cwd = "/tmp/pi-threads-mode-on";
	const sessionFile = path.join(cwd, ".pi", "sessions", "parent.jsonl");

	const behavior = deriveSessionBehavior({
		cwd,
		sessionFile,
		state: { enabled: true, parentBySession: {} },
	});

	assert.equal(behavior.kind, "orchestrator");
	assert.equal(behavior.shouldAppendOrchestratorPrompt, true);
	assert.equal(behavior.parentSessionFile, undefined);
});

test("deriveSessionBehavior keeps thread sessions normal and remembers their parent", () => {
	const cwd = "/tmp/pi-threads-subagent";
	const sessionFile = path.join(cwd, ".pi", "threads", "worker.jsonl");
	const parentSession = path.join(cwd, ".pi", "sessions", "parent.jsonl");

	const behavior = deriveSessionBehavior({
		cwd,
		sessionFile,
		state: {
			enabled: true,
			parentBySession: {
				[sessionFile]: parentSession,
			},
		},
	});

	assert.equal(behavior.kind, "subagent");
	assert.equal(behavior.shouldAppendOrchestratorPrompt, false);
	assert.equal(behavior.parentSessionFile, parentSession);
});

test("resolveActiveToolsForBehavior strips built-in file/shell tools only in orchestrator mode", () => {
	const currentActiveTools = ["read", "bash", "custom-tool"];
	const allTools = [...BUILTIN_FILE_SHELL_TOOLS, "dispatch", "custom-tool"];

	assert.deepEqual(
		resolveActiveToolsForBehavior("normal", currentActiveTools, allTools),
		currentActiveTools,
	);

	assert.deepEqual(
		resolveActiveToolsForBehavior("orchestrator", currentActiveTools, allTools).sort(),
		["custom-tool", "dispatch"],
	);
});

test("resolveActiveToolsForBehavior restores interactive tools when leaving a dispatch-only orchestrator session", () => {
	const allTools = [...BUILTIN_FILE_SHELL_TOOLS, "dispatch", "custom-tool"];

	assert.deepEqual(
		resolveActiveToolsForBehavior("normal", ["dispatch"], allTools),
		["read", "write", "edit", "bash", "custom-tool"],
	);
});
