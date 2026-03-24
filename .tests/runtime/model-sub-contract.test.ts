import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { PiActorRuntime } from "../../src/runtime/pi-actor";
import {
	makeCommandContext,
	makeFakePi,
	makeTempProject,
	patchPiActorInvoke,
	writeThreadSession,
} from "../helpers/subagent-test-helpers";

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
	return makeCommandContext({
		cwd: projectDir,
		sessionFile: parentSession,
		branch: [],
		model: splitCanonicalModel(model),
	}) as any;
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
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");

		const capturedModels: Array<string | undefined> = [];
		const restoreInvoke = patchPiActorInvoke(function (request: any) {
			capturedModels.push(request.model);
			return {
				result: Promise.resolve(makeAssistantResult(request.runId, request.thread, "hello", request.model)),
				subscribe: () => () => {},
				cancel: () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			await dispatch.execute!(
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
			restoreInvoke();
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
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const modelSub = fakePi.commands.get("model-sub");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");
		assert.ok(modelSub, "/model-sub should be registered");

		await modelSub!.handler(subagentModel, makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [],
		}) as any);

		const capturedModels: Array<string | undefined> = [];
		const restoreInvoke = patchPiActorInvoke(function (request: any) {
			capturedModels.push(request.model);
			return {
				result: Promise.resolve(makeAssistantResult(request.runId, request.thread, "hello", request.model)),
				subscribe: () => () => {},
				cancel: () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			await dispatch.execute!(
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
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
