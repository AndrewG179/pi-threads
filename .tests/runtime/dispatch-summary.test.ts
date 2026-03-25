import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { PiActorRuntime } from "../../src/runtime/pi-actor";
import { getThreadSessionPath } from "../../src/subagents/metadata";
import {
	makeCommandContext,
	makeFakePi,
	makeTempProject,
	patchPiActorInvoke,
	writeThreadSession,
} from "../helpers/subagent-test-helpers";

function makeAssistantResult(
	runId: string,
	thread: string,
	text: string,
	overrides: Partial<Awaited<ReturnType<PiActorRuntime["invoke"]>["result"]>> = {},
) {
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
		model: "openai-codex/gpt-5.4",
		...overrides,
	};
}

function makeDispatchContext(projectDir: string, parentSession: string) {
	return makeCommandContext({
		cwd: projectDir,
		sessionFile: parentSession,
		branch: [],
		model: { provider: "openai-codex", id: "gpt-5.4" },
	}) as any;
}

test("dispatch should surface hard child failures even when the child produced no assistant messages", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const childError = "spawn pi ENOENT";

	try {
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");

		const restoreInvoke = patchPiActorInvoke(function () {
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
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			const result = await dispatch.execute!(
				"tool-call-1",
				{ thread: "smoke-fast", action: "Respond with exactly: hello" },
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession),
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
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("dispatch should reject duplicate same-thread tasks in one batch before any child run starts", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");

		let invokeCalls = 0;
		const restoreInvoke = patchPiActorInvoke(function (request) {
			invokeCalls += 1;
			return {
				result: Promise.resolve(
					makeAssistantResult(
						request.runId,
						request.thread,
						`done ${request.action}`,
					),
				),
				subscribe: () => () => {},
				cancel: () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			const first = await dispatch.execute!(
				"tool-call-batch-duplicate-thread",
				{
					tasks: [
						{ thread: "alpha", action: "first alpha task" },
						{ thread: "alpha", action: "second alpha task" },
					],
				},
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession),
			) as any;

			assert.equal(first.isError, true);
			assert.equal(first.details?.mode, "batch");
			assert.deepEqual(first.details?.items, []);
			assert.match(
				first.content[0]?.text ?? "",
				/alpha/,
				"the error should name the duplicate thread",
			);
			assert.match(
				first.content[0]?.text ?? "",
				/separate dispatches|different thread names/i,
				"the error should tell the caller how to resolve the duplicate-thread batch",
			);
			assert.equal(invokeCalls, 0, "duplicate-thread validation should reject the batch before any child runtime starts");

			const second = await dispatch.execute!(
				"tool-call-follow-up-alpha",
				{ thread: "alpha", action: "third alpha task" },
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession),
			) as any;

			assert.equal(second.details?.mode, "single");
			assert.equal(
				second.details?.items?.[0]?.episodeNumber,
				1,
				"after a rejected duplicate-thread batch, the next same-thread dispatch should still begin at episode 1",
			);
			assert.equal(invokeCalls, 1);
		} finally {
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("dispatch should reject batch tasks whose thread names normalize to the same session path", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");

		const threadsDir = path.join(projectDir, ".pi", "threads");
		const alphaSpace = getThreadSessionPath(threadsDir, "alpha beta");
		const alphaSlash = getThreadSessionPath(threadsDir, "alpha/beta");
		assert.equal(alphaSpace, alphaSlash, "the test inputs should target the same normalized worker session file");

		let invokeCalls = 0;
		const restoreInvoke = patchPiActorInvoke(function (request) {
			invokeCalls += 1;
			return {
				result: Promise.resolve(makeAssistantResult(request.runId, request.thread, `done ${request.action}`)),
				subscribe: () => () => {},
				cancel: () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			const result = await dispatch.execute!(
				"tool-call-batch-normalized-duplicate-thread",
				{
					tasks: [
						{ thread: "alpha beta", action: "first alpha alias task" },
						{ thread: "alpha/beta", action: "second alpha alias task" },
					],
				},
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession),
			) as any;

			assert.equal(result.isError, true);
			assert.equal(result.details?.mode, "batch");
			assert.deepEqual(result.details?.items, []);
			assert.match(
				result.content[0]?.text ?? "",
				/alpha beta|alpha\/beta/,
				"the error should identify the normalized duplicate threads",
			);
			assert.match(
				result.content[0]?.text ?? "",
				/duplicate|same session path|same worker session/i,
				"the error should explain that the batch would collide on one worker session",
			);
			assert.equal(
				invokeCalls,
				0,
				"normalized duplicate-thread validation should reject the batch before any child runtime starts",
			);
		} finally {
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("dispatch should continue episode numbering across separate dispatches that target the same normalized worker session", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");

		const threadsDir = path.join(projectDir, ".pi", "threads");
		const aliasAPath = getThreadSessionPath(threadsDir, "collision/a");
		const aliasBPath = getThreadSessionPath(threadsDir, "collision_a");
		assert.equal(aliasAPath, aliasBPath, "the alias inputs should resolve to the same canonical worker session path");

		const invokedSessionPaths: string[] = [];
		const restoreInvoke = patchPiActorInvoke(function (request) {
			assert.equal(typeof request.sessionPath, "string");
			invokedSessionPaths.push(request.sessionPath!);
			return {
				result: Promise.resolve(makeAssistantResult(request.runId, request.thread, `done ${request.action}`)),
				subscribe: () => () => {},
				cancel: () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			const first = await dispatch.execute!(
				"tool-call-alias-first",
				{ thread: "collision/a", action: "first alias task" },
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession),
			) as any;
			const second = await dispatch.execute!(
				"tool-call-alias-second",
				{ thread: "collision_a", action: "second alias task" },
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession),
			) as any;

			assert.equal(first.details?.items?.[0]?.result?.sessionPath, aliasAPath);
			assert.equal(second.details?.items?.[0]?.result?.sessionPath, aliasBPath);
			assert.deepEqual(invokedSessionPaths, [aliasAPath, aliasBPath]);
			assert.equal(first.details?.items?.[0]?.episodeNumber, 1);
			assert.equal(
				second.details?.items?.[0]?.episodeNumber,
				2,
				"separate dispatches to aliases of the same worker session should continue canonical episode numbering",
			);
		} finally {
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("dispatch should represent a genuinely aborted tool call as aborted instead of waiting for child success", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");

		const restoreInvoke = patchPiActorInvoke(function (request) {
			let resolveResult!: (value: Awaited<ReturnType<PiActorRuntime["invoke"]>["result"]>) => void;
			let cancelled = false;
			return {
				result: new Promise((resolve) => {
					resolveResult = resolve;
					setTimeout(() => {
						if (!cancelled) {
							resolve(makeAssistantResult(request.runId, request.thread, "done"));
						}
					}, 400);
				}),
				subscribe: () => () => {},
				cancel: () => {
					cancelled = true;
					resolveResult(makeAssistantResult(request.runId, request.thread, "", {
						finalState: { tag: "exited", exitCode: 1, signal: null },
						stopReason: "aborted",
						errorMessage: "aborted",
					}));
				},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 50);

			const startedAt = Date.now();
			const result = await dispatch.execute!(
				"tool-call-real-abort",
				{ thread: "alpha", action: "run slow work" },
				controller.signal,
				undefined,
				makeDispatchContext(projectDir, parentSession),
			) as any;
			const durationMs = Date.now() - startedAt;

			assert.equal(result.isError, true, "a genuinely aborted dispatch should be treated as an error result");
			assert.equal(
				result.details?.items?.[0]?.result?.stopReason,
				"aborted",
				"a genuinely aborted dispatch should surface stopReason=aborted in structured result details",
			);
			assert.equal(
				durationMs < 250,
				true,
				"a genuinely aborted dispatch should settle before the full slow child success path completes",
			);
		} finally {
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("dispatch should not report exitCode = 0 when the real child process fails to start", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session" }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch?.execute, "dispatch tool should be registered");

		const missingCommand = "/definitely/missing/pi";
		const missingRuntime = new PiActorRuntime({ command: missingCommand });
		const originalInvoke = PiActorRuntime.prototype.invoke;
		const restoreInvoke = patchPiActorInvoke(function (request) {
			return originalInvoke.call(missingRuntime, request);
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			const result = await dispatch.execute!(
				"tool-call-real-start-failure",
				{ thread: "smoke-fast", action: "Respond with exactly: hello" },
				undefined,
				undefined,
				makeDispatchContext(projectDir, parentSession),
			) as any;

			assert.equal(result.isError, true);
			assert.equal(result.details?.items?.[0]?.result?.stopReason, "error");
			assert.notEqual(
				result.details?.items?.[0]?.result?.exitCode,
				0,
				"a real child-start failure should not be surfaced as exitCode = 0",
			);
			assert.match(
				result.details?.items?.[0]?.result?.errorMessage ?? "",
				/ENOENT/,
				"the structured result should still carry the real startup failure detail",
			);
		} finally {
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
