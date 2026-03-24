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

type RegisteredEventHandler = (event: unknown, ctx: Record<string, unknown>) => Promise<unknown> | unknown;

type BrowserLike = {
	handleInput(input: string): void;
	render(width: number): string[];
	invalidate(): void;
};

function makeTempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-runtime-simplify-"));
}

function makeFakePi() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void }>();
	const events = new Map<string, RegisteredEventHandler[]>();

	return {
		on(event: string, listener: RegisteredEventHandler) {
			const handlers = events.get(event) ?? [];
			handlers.push(listener);
			events.set(event, handlers);
		},
		registerCommand(name: string, config: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void }) {
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
		events,
	};
}

function makeSelectKeybindings() {
	return {
		matches(input: string, command: string) {
			return (
				(input === "UP" && command === "tui.select.up") ||
				(input === "DOWN" && command === "tui.select.down") ||
				(input === "ENTER" && command === "tui.select.confirm") ||
				(input === "ESC" && command === "tui.select.cancel")
			);
		},
	};
}

function makeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};
}

function writeThreadSession(filePath: string, lines: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
		"utf8",
	);
}

function createBrowserPromise(
	factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
): { browser: BrowserLike; result: Promise<unknown> } {
	let browser!: BrowserLike;
	const result = new Promise<unknown>((resolve) => {
		browser = factory(
			{ terminal: { rows: 24 } },
			makeTheme(),
			makeSelectKeybindings(),
			resolve,
		) as BrowserLike;
	});

	return { browser, result };
}

test("/subagents should refresh live card details from the runtime-owned run store while the browser stays open", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		assert.ok(dispatch, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let emitMessage!: (text: string) => void;
		let finishRun!: () => void;
		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function (request: any) {
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
				getSnapshot: () => ({
					runId: request.runId,
					thread: request.thread,
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		const execution = dispatch.execute(
			"tool-call-live-refresh",
			{ thread: "alpha", action: "Inspect alpha while it is still running" },
			undefined,
			undefined,
			{
				cwd: projectDir,
				hasUI: true,
				ui: { notify: () => {} },
				sessionManager: {
					getSessionFile: () => parentSession,
					getBranch: () => [],
				},
				model: { provider: "openai-codex", id: "gpt-5.4" },
			} as any,
		);

		let browser: BrowserLike | undefined;
		const handlerPromise = subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			ui: {
				notify: () => {},
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [],
			},
		} as any);

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
			PiActorRuntime.prototype.invoke = originalInvoke;
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
		assert.ok(dispatch, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let finishRun!: () => void;
		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function (request: any) {
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
				getSnapshot: () => ({
					runId: request.runId,
					thread: request.thread,
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		let browser: BrowserLike | undefined;
		const handlerPromise = subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			ui: {
				notify: () => {},
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [],
			},
		} as any);

		try {
			await Promise.resolve();
			assert.match(browser!.render(80).join("\n"), /No subagent runs in this session\./);

			const execution = dispatch.execute(
				"tool-call-new-live-child",
				{ thread: "alpha", action: "Inspect alpha while it is still running" },
				undefined,
				undefined,
				{
					cwd: projectDir,
					hasUI: true,
					ui: { notify: () => {} },
					sessionManager: {
						getSessionFile: () => parentSession,
						getBranch: () => [],
					},
					model: { provider: "openai-codex", id: "gpt-5.4" },
				} as any,
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
			PiActorRuntime.prototype.invoke = originalInvoke;
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
		const handlerPromise = subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => {
				switchCalls++;
				return { cancelled: false };
			},
			ui: {
				notify: () => {},
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [{
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
			},
		} as any);

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
		assert.ok(dispatch, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		const parentDispatchController = new AbortController();
		let finishRun!: () => void;
		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function (request: any) {
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
				getSnapshot: () => ({
					runId: request.runId,
					thread: request.thread,
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		const execution = dispatch.execute(
			"tool-call-no-switch-abort",
			{ thread: "alpha", action: "Run slow background work and finish cleanly" },
			parentDispatchController.signal,
			undefined,
			{
				cwd: projectDir,
				hasUI: true,
				ui: { notify: () => {} },
				sessionManager: {
					getSessionFile: () => parentSession,
					getBranch: () => [],
				},
				model: { provider: "openai-codex", id: "gpt-5.4" },
			} as any,
		);

		let browser: BrowserLike | undefined;
		let switchCalls = 0;
		const handlerPromise = subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => {
				switchCalls++;
				parentDispatchController.abort();
				return { cancelled: false };
			},
			ui: {
				notify: () => {},
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [],
			},
		} as any);

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
			PiActorRuntime.prototype.invoke = originalInvoke;
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
		assert.ok(dispatch, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let emitMessage!: (text: string) => void;
		let finishRun!: () => void;
		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function (request: any) {
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
				getSnapshot: () => ({
					runId: request.runId,
					thread: request.thread,
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		const execution = dispatch.execute(
			"tool-call-parent-completion-after-view-changes",
			{ thread: "alpha", action: "Keep working while the user opens and closes /subagents" },
			undefined,
			undefined,
			{
				cwd: projectDir,
				hasUI: true,
				ui: { notify: () => {} },
				sessionManager: {
					getSessionFile: () => parentSession,
					getBranch: () => [],
				},
				model: { provider: "openai-codex", id: "gpt-5.4" },
			} as any,
		);

		let browser: BrowserLike | undefined;
		let switchCalls = 0;
		const handlerPromise = subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => {
				switchCalls++;
				return { cancelled: false };
			},
			ui: {
				notify: () => {},
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) => {
					const created = createBrowserPromise(factory);
					browser = created.browser;
					return created.result;
				},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [],
			},
		} as any);

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

			assert.equal(switchCalls, 0, "opening the browser and inspector should remain a same-session view concern");
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
			PiActorRuntime.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
