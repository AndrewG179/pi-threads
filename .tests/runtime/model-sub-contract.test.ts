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

type RegisteredCommand = {
	handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

function makeTempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-model-sub-runtime-"));
}

function makeFakePi() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();

	return {
		on: () => {},
		registerCommand(name: string, config: RegisteredCommand) {
			commands.set(name, config);
		},
		registerShortcut: () => {},
		registerTool(config: RegisteredTool) {
			tools.set(config.name, config);
		},
		getActiveTools: () => ["read", "write", "edit", "bash", "dispatch"],
		getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "dispatch" }],
		setActiveTools: () => {},
		tools,
		commands,
	};
}

function writeParentSession(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, '{"type":"session"}\n', "utf8");
}

function splitCanonicalModel(model: string): { provider: string; id: string } {
	const slashIndex = model.indexOf("/");
	if (slashIndex === -1) {
		return { provider: "", id: model };
	}
	return {
		provider: model.slice(0, slashIndex),
		id: model.slice(slashIndex + 1),
	};
}

function makeDispatchContext(projectDir: string, parentSession: string, model: string) {
	const parsedModel = splitCanonicalModel(model);
	return {
		cwd: projectDir,
		hasUI: true,
		ui: {
			notify: () => {},
		},
		sessionManager: {
			getSessionFile: () => parentSession,
			getBranch: () => [],
		},
		model: parsedModel,
	} as any;
}

function makeAssistantResult(runId: string, thread: string, text: string, model: string | undefined) {
	return {
		runId,
		thread,
		finalState: { tag: "exited" as const, exitCode: 0, signal: null },
		messages: [{
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
		}],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		model,
	};
}

test("dispatch should inherit the parent session model when no /model-sub override is set", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const parentModel = "google/gemini-2.5-flash";

	try {
		writeParentSession(parentSession);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch, "dispatch tool should be registered");

		const capturedModels: Array<string | undefined> = [];
		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function (request: any) {
			capturedModels.push(request.model);
			return {
				result: Promise.resolve(makeAssistantResult(request.runId, request.thread, "hello", request.model)),
				subscribe: () => () => {},
				cancel: () => {},
			} as any;
		};

		try {
			await dispatch.execute(
				"tool-call-model-inherit",
				{ thread: "alpha", action: "Respond with exactly: hello" },
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession, parentModel),
			);

			assert.deepEqual(
				capturedModels,
				[parentModel],
				"without a /model-sub override, worker launches should inherit the parent provider/model",
			);
		} finally {
			PiActorRuntime.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("dispatch should use the explicit /model-sub provider/model override for worker launches", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const parentModel = "openai-codex/gpt-5.4";
	const subagentModel = "google/gemini-2.5-flash";

	try {
		writeParentSession(parentSession);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const modelSub = fakePi.commands.get("model-sub");
		assert.ok(dispatch, "dispatch tool should be registered");
		assert.ok(modelSub, "/model-sub should be registered");

		await modelSub!.handler(subagentModel, {
			cwd: projectDir,
			hasUI: true,
			ui: {
				notify: () => {},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [],
			},
		} as any);

		const capturedModels: Array<string | undefined> = [];
		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function (request: any) {
			capturedModels.push(request.model);
			return {
				result: Promise.resolve(makeAssistantResult(request.runId, request.thread, "hello", request.model)),
				subscribe: () => () => {},
				cancel: () => {},
			} as any;
		};

		try {
			await dispatch.execute(
				"tool-call-model-override",
				{ thread: "alpha", action: "Respond with exactly: hello" },
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession, parentModel),
			);

			assert.deepEqual(
				capturedModels,
				[subagentModel],
				"after /model-sub provider/model, worker launches should use the explicit subagent model override",
			);
		} finally {
			PiActorRuntime.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
