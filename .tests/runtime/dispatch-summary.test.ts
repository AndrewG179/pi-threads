import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { PiActorRuntime } from "../../src/runtime/pi-actor";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: Record<string, unknown>,
	) => Promise<unknown>;
};

function makeTempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-dispatch-summary-"));
}

function makeFakePi() {
	const tools = new Map<string, RegisteredTool>();

	return {
		on: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool(config: RegisteredTool) {
			tools.set(config.name, config);
		},
		getActiveTools: () => ["read", "write", "edit", "bash", "dispatch"],
		getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "dispatch" }],
		setActiveTools: () => {},
		tools,
	};
}

test("dispatch should surface hard child failures even when the child produced no assistant messages", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const childError = "spawn pi ENOENT";

	try {
		fs.mkdirSync(path.dirname(parentSession), { recursive: true });
		fs.writeFileSync(parentSession, "{\"type\":\"session\"}\n", "utf8");

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch, "dispatch tool should be registered");

		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function () {
			return {
				runId: "run-1",
				thread: "smoke-fast",
				result: Promise.resolve({
					runId: "run-1",
					thread: "smoke-fast",
					finalState: { tag: "exited", exitCode: 1, signal: null },
					messages: [],
					stderr: childError,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					model: "openai-codex/gpt-5.4",
					stopReason: "error",
					errorMessage: childError,
				}),
				cancel: async () => {},
				subscribe: () => () => {},
				getSnapshot: () => ({
					runId: "run-1",
					thread: "smoke-fast",
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "exited", exitCode: 1, signal: null },
				}),
			} as any;
		};

		try {
			const result = await dispatch.execute(
				"tool-call-1",
				{ thread: "smoke-fast", action: "Respond with exactly: hello" },
				undefined,
				undefined,
				{
					cwd: projectDir,
					hasUI: true,
					ui: {
						notify: () => {},
					},
					sessionManager: {
						getSessionFile: () => parentSession,
						getBranch: () => [],
					},
					model: { provider: "openai-codex", id: "gpt-5.4" },
				} as any,
			);

			assert.equal((result as any).isError, true);
			assert.match(
				(result as any).content[0].text,
				new RegExp(childError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				"dispatch summaries should surface the child failure instead of hiding it behind a placeholder",
			);
			assert.doesNotMatch(
				(result as any).content[0].text,
				/\(no output\)/,
				"dispatch summaries should not collapse hard child failures to '(no output)'",
			);
		} finally {
			PiActorRuntime.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
