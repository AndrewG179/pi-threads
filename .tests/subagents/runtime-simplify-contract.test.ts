import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { PiActorRuntime } from "../../src/runtime/pi-actor";
import {
	type BrowserLike,
	createBrowserPromise,
	makeCommandContext,
	makeFakePi,
	makeTempProject,
	patchPiActorInvoke,
	writeThreadSession,
} from "../helpers/subagent-test-helpers";

test("/subagents should refresh live card details from the runtime-owned run store while the browser stays open", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		assert.ok(dispatch?.execute, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let emitMessage!: (text: string) => void;
		let finishRun!: () => void;
		const restoreInvoke = patchPiActorInvoke(function (request: any) {
			let listener: ((event: unknown) => void) | undefined;
			let resolveResult!: (value: unknown) => void;
			const result = new Promise((resolve) => {
				resolveResult = resolve;
			});

			emitMessage = (text: string) => {
				listener?.({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						usage: { cost: { total: 0.01 } },
					},
				});
			};

			finishRun = () => {
				resolveResult({
					runId: request.runId,
					thread: request.thread,
					finalState: { tag: "exited", exitCode: 0, signal: null },
					messages: [{
						role: "assistant",
						content: [{ type: "text", text: "PROGRESS-TWO" }],
					}],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
					model: "openai-codex/gpt-5.4",
				});
			};

			return {
				runId: request.runId,
				thread: request.thread,
				result,
				cancel: async () => {},
				subscribe(next: (event: unknown) => void) {
					listener = next;
					return () => {
						if (listener === next) listener = undefined;
					};
				},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		const execution = dispatch.execute!(
			"tool-call-live-refresh",
			{ thread: "alpha", action: "Inspect alpha while it is still running" },
			undefined,
			undefined,
			makeCommandContext({
				cwd: projectDir,
				sessionFile: parentSession,
				branch: [],
				model: { provider: "openai-codex", id: "gpt-5.4" },
			}) as any,
		);

		let browser: BrowserLike | undefined;
		const handlerPromise = subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [],
			ui: {
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
		}) as any);

		try {
			await Promise.resolve();
			emitMessage("PROGRESS-ONE");
			browser!.invalidate();
			assert.match(browser!.render(80).join("\n"), /PROGRESS-ONE/);

			emitMessage("PROGRESS-TWO");
			browser!.invalidate();
			assert.match(
				browser!.render(80).join("\n"),
				/PROGRESS-TWO/,
				"while /subagents stays open, the runtime-owned store should surface fresh child output without requiring the browser to be reopened",
			);
		} finally {
			finishRun();
			if (browser) browser.handleInput("ESC");
			await handlerPromise;
			await execution;
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should discover a newly started current-session child while the browser is already open and before any completed toolResult exists", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		assert.ok(dispatch?.execute, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let finishRun!: () => void;
		const restoreInvoke = patchPiActorInvoke(function (request: any) {
			let resolveResult!: (value: unknown) => void;
			const result = new Promise((resolve) => {
				resolveResult = resolve;
			});
			finishRun = () => {
				resolveResult({
					runId: request.runId,
					thread: request.thread,
					finalState: { tag: "exited", exitCode: 0, signal: null },
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					model: "openai-codex/gpt-5.4",
				});
			};

			return {
				runId: request.runId,
				thread: request.thread,
				result,
				cancel: async () => {},
				subscribe: () => () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		let browser: BrowserLike | undefined;
		const handlerPromise = subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [],
			ui: {
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
		}) as any);

		try {
			await Promise.resolve();
			assert.match(browser!.render(80).join("\n"), /No subagent runs in this session\./);

			const execution = dispatch.execute!(
				"tool-call-new-live-child",
				{ thread: "alpha", action: "Inspect alpha while it is still running" },
				undefined,
				undefined,
				makeCommandContext({
					cwd: projectDir,
					sessionFile: parentSession,
					branch: [],
					model: { provider: "openai-codex", id: "gpt-5.4" },
				}) as any,
			);

			await Promise.resolve();
			browser!.invalidate();
			assert.match(
				browser!.render(80).join("\n"),
				/\[alpha\]/,
				"/subagents should list a live child from the runtime store before any parent-side completed dispatch metadata exists",
			);

			finishRun();
			await execution;
		} finally {
			if (browser) browser.handleInput("ESC");
			await handlerPromise;
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should stay in the same host session: Enter opens the inspector, Esc returns to the browser, and switchSession is never called", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");
	const betaSession = path.join(projectDir, ".pi", "threads", "beta.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(alphaSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(betaSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		assert.ok(subagents, "/subagents should be registered");

		let browser: BrowserLike | undefined;
		let switchCalls = 0;
		const handlerPromise = subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "dispatch",
					details: {
						mode: "batch",
						items: [
							{
								thread: "alpha",
								action: "Inspect alpha",
								episode: "alpha ready",
								episodeNumber: 1,
								result: {
									exitCode: 0,
									stderr: "",
									messages: [{ role: "assistant", content: [{ type: "text", text: "alpha ready" }] }],
									usage: { cost: 0.01 },
									sessionPath: alphaSession,
								},
							},
							{
								thread: "beta",
								action: "Inspect beta",
								episode: "beta ready",
								episodeNumber: 1,
								result: {
									exitCode: 0,
									stderr: "",
									messages: [{ role: "assistant", content: [{ type: "text", text: "beta ready" }] }],
									usage: { cost: 0.02 },
									sessionPath: betaSession,
								},
							},
						],
					},
				},
			}],
			switchSession: async () => {
				switchCalls++;
				return { cancelled: false };
			},
			ui: {
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
		}) as any);

		try {
			await Promise.resolve();
			assert.match(browser!.render(80).join("\n"), /Selected/);

			browser!.handleInput("DOWN");
			browser!.handleInput("ENTER");
			assert.match(browser!.render(80).join("\n"), /Subagent \[beta\]/);
			assert.equal(switchCalls, 0, "inspecting a subagent should stay inside the same custom view, not call switchSession");

			browser!.handleInput("ESC");
			assert.match(browser!.render(80).join("\n"), /Selected/);
			browser!.handleInput("ESC");
			await handlerPromise;
			assert.equal(switchCalls, 0);
		} finally {
			if (browser) browser.handleInput("ESC");
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents view interactions should not trigger host switchSession abort behavior while a parent dispatch is running", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		assert.ok(dispatch?.execute, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		const parentDispatchController = new AbortController();
		let finishRun!: () => void;
		const restoreInvoke = patchPiActorInvoke(function (request: any) {
			let resolveResult!: (value: unknown) => void;
			const result = new Promise((resolve) => {
				resolveResult = resolve;
			});
			finishRun = () => {
				resolveResult({
					runId: request.runId,
					thread: request.thread,
					finalState: { tag: "exited", exitCode: 0, signal: null },
					messages: [{
						role: "assistant",
						content: [{ type: "text", text: "SUBAGENT-DONE" }],
					}],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
					model: "openai-codex/gpt-5.4",
				});
			};

			return {
				runId: request.runId,
				thread: request.thread,
				result,
				cancel: async () => {},
				subscribe: () => () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		const execution = dispatch.execute!(
			"tool-call-no-switch-abort",
			{ thread: "alpha", action: "Run slow background work and finish cleanly" },
			parentDispatchController.signal,
			undefined,
			makeCommandContext({
				cwd: projectDir,
				sessionFile: parentSession,
				branch: [],
				model: { provider: "openai-codex", id: "gpt-5.4" },
			}) as any,
		);

		let browser: BrowserLike | undefined;
		let switchCalls = 0;
		const handlerPromise = subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [],
			switchSession: async () => {
				switchCalls++;
				parentDispatchController.abort();
				return { cancelled: false };
			},
			ui: {
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
		}) as any);

		try {
			await Promise.resolve();
			browser!.handleInput("ENTER");
			browser!.handleInput("ESC");
			browser!.handleInput("ESC");
			await handlerPromise;

			finishRun();
			const result = await execution as {
				isError?: boolean;
				details?: { items?: Array<{ result?: { stopReason?: string; exitCode?: number } }> };
			};

			assert.equal(switchCalls, 0, "same-session inspection should never call switchSession");
			assert.equal(parentDispatchController.signal.aborted, false);
			assert.equal(result.details?.items?.[0]?.result?.stopReason, undefined);
			assert.equal(result.details?.items?.[0]?.result?.exitCode, 0);
			assert.equal(result.isError, undefined);
		} finally {
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents browser and inspector view changes should not stall dispatch completion after live child progress", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		assert.ok(dispatch?.execute, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let emitMessage!: (text: string) => void;
		let finishRun!: () => void;
		const restoreInvoke = patchPiActorInvoke(function (request: any) {
			let listener: ((event: unknown) => void) | undefined;
			let resolveResult!: (value: unknown) => void;
			const result = new Promise((resolve) => {
				resolveResult = resolve;
			});

			emitMessage = (text: string) => {
				listener?.({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						usage: { cost: { total: 0.01 } },
					},
				});
			};

			finishRun = () => {
				resolveResult({
					runId: request.runId,
					thread: request.thread,
					finalState: { tag: "exited", exitCode: 0, signal: null },
					messages: [{
						role: "assistant",
						content: [{ type: "text", text: "CHILD-FINISHED" }],
					}],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.03, contextTokens: 0, turns: 1 },
					model: "openai-codex/gpt-5.4",
				});
			};

			return {
				runId: request.runId,
				thread: request.thread,
				result,
				cancel: async () => {},
				subscribe(next: (event: unknown) => void) {
					listener = next;
					return () => {
						if (listener === next) listener = undefined;
					};
				},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		const execution = dispatch.execute!(
			"tool-call-parent-completion-after-view-changes",
			{ thread: "alpha", action: "Keep working while the user opens and closes /subagents" },
			undefined,
			undefined,
			makeCommandContext({
				cwd: projectDir,
				sessionFile: parentSession,
				branch: [],
				model: { provider: "openai-codex", id: "gpt-5.4" },
			}) as any,
		);

		let browser: BrowserLike | undefined;
		const handlerPromise = subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [],
			ui: {
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
		}) as any);

		try {
			await Promise.resolve();
			assert.match(browser!.render(80).join("\n"), /\[alpha\]/);

			emitMessage("LIVE-STEP:1");
			browser!.invalidate();
			assert.match(
				browser!.render(80).join("\n"),
				/LIVE-STEP:1/,
				"the live browser should keep refreshing child output while it stays open",
			);

			browser!.handleInput("ENTER");
			assert.match(browser!.render(80).join("\n"), /Subagent \[alpha\]/);

			emitMessage("LIVE-STEP:2");
			browser!.invalidate();
			assert.match(
				browser!.render(80).join("\n"),
				/LIVE-STEP:2/,
				"the same-session inspector should keep showing fresh child progress while the run is still active",
			);

			browser!.handleInput("ESC");
			assert.match(browser!.render(80).join("\n"), /Selected/);
			browser!.handleInput("ESC");
			await handlerPromise;

			finishRun();
			const result = await execution as {
				content?: Array<{ text?: string }>;
				details?: {
					items?: Array<{
						episode?: string;
						result?: {
							exitCode?: number;
							messages?: Array<{
								content?: Array<{ type?: string; text?: string }>;
							}>;
						};
					}>;
				};
			};

			assert.equal(result.details?.items?.[0]?.result?.exitCode, 0);
			assert.equal(
				result.details?.items?.[0]?.result?.messages?.[0]?.content?.[0]?.text,
				"CHILD-FINISHED",
				"the child should still finish cleanly after the user changes views",
			);
			assert.equal(
				typeof result.details?.items?.[0]?.episode,
				"string",
				"the parent dispatch should still return a finished episode for the child after the view changes",
			);
			assert.match(
				result.details?.items?.[0]?.episode ?? "",
				/CHILD-FINISHED/,
				"the parent dispatch should still compress and return the finished child result after the view changes",
			);
			assert.match(
				result.content?.[0]?.text ?? "",
				/\[alpha\][\s\S]*CHILD-FINISHED/,
				"the parent tool result text should still include the finished child output after the view changes",
			);
		} finally {
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
