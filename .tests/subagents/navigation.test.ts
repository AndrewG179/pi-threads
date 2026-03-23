import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { ThreadSupervisor } from "../../src/runtime/thread-supervisor";
import { loadThreadsState } from "../../src/subagents/state";

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

type RegisteredShortcut = {
	description?: string;
	handler: (ctx: Record<string, unknown>) => Promise<void> | void;
};

type RegisteredEventHandler = (event: unknown, ctx: Record<string, unknown>) => Promise<unknown> | unknown;

function makeTempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-navigation-"));
}

function makeFakePi() {
	const tools = new Map<string, RegisteredTool>();
	const shortcuts = new Map<string, RegisteredShortcut>();
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
		registerShortcut(name: string, config: RegisteredShortcut) {
			shortcuts.set(name, config);
		},
		registerTool(config: RegisteredTool) {
			tools.set(config.name, config);
		},
		getActiveTools: () => ["read", "write", "edit", "bash", "dispatch"],
		getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "dispatch" }],
		setActiveTools: () => {},
		tools,
		shortcuts,
		commands,
		events,
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

test("dispatch should not persist parent linkage in state.json", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		fs.mkdirSync(path.dirname(parentSession), { recursive: true });
		fs.writeFileSync(parentSession, "{\"type\":\"session\"}\n", "utf8");

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		assert.ok(dispatch, "dispatch tool should be registered");

		const originalInvoke = ThreadSupervisor.prototype.invoke;
		ThreadSupervisor.prototype.invoke = function () {
			return {
				runId: "run-1",
				thread: "smoke-fast",
				result: Promise.resolve({
					runId: "run-1",
					thread: "smoke-fast",
					finalState: { tag: "exited", exitCode: 0, signal: null },
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					model: "openai-codex/gpt-5.4",
				}),
				cancel: async () => {},
				subscribe: () => () => {},
				getSnapshot: () => ({
					runId: "run-1",
					thread: "smoke-fast",
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "exited", exitCode: 0, signal: null },
				}),
			} as any;
		};

		try {
			await dispatch.execute(
				"tool-call-1",
				{ thread: "smoke-fast", action: "Respond with exactly: hello" },
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
		} finally {
			ThreadSupervisor.prototype.invoke = originalInvoke;
		}

		assert.deepEqual(loadThreadsState(projectDir), { enabled: false });
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should establish runtime-only back navigation for the opened subagent", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(alphaSession, [
			{ type: "session", version: 3, cwd: projectDir },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Inspect alpha" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "alpha ready" }],
				},
			},
		]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		const backCommand = fakePi.commands.get("subagents-back");
		const sessionStartHandlers = fakePi.events.get("session_start") ?? [];
		assert.ok(subagents, "/subagents should be registered");
		assert.ok(backCommand, "/subagents-back should be registered");
		assert.equal(fakePi.shortcuts.get("ctrl+b"), undefined, "ctrl+b should not be registered through the shortcut API");

		const switchedSessions: string[] = [];
		await subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async (sessionPath: string) => {
				switchedSessions.push(sessionPath);
				return { cancelled: false };
			},
			ui: {
				notify: () => {},
				custom: async () => ({
					thread: "alpha",
					sessionPath: alphaSession,
					latestAction: "Inspect alpha",
					outputPreview: "alpha ready",
					toolPreview: "",
					accumulatedCost: 0.02,
					status: "done",
				}),
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "dispatch",
						details: {
							mode: "single",
							items: [{
								thread: "alpha",
								action: "Inspect alpha",
								episode: "alpha ready",
								episodeNumber: 1,
								result: {
									exitCode: 0,
									stderr: "",
									messages: [{ role: "assistant", content: [{ type: "text", text: "alpha ready" }] }],
									usage: {
										input: 12,
										output: 8,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0.02,
										contextTokens: 20,
										turns: 1,
									},
									sessionPath: alphaSession,
									isNewThread: false,
								},
							}],
						},
					},
				}],
			},
		} as any);

		assert.deepEqual(switchedSessions, [alphaSession]);

		let terminalInputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		for (const handler of sessionStartHandlers) {
			await handler({}, {
				cwd: projectDir,
				hasUI: true,
				ui: {
					notify: () => {},
					setStatus: () => {},
					setWidget: () => {},
					theme: {
						fg: (_color: string, text: string) => text,
					},
					onTerminalInput(handlerFn: (data: string) => { consume?: boolean; data?: string } | undefined) {
						terminalInputHandler = handlerFn;
						return () => {
							if (terminalInputHandler === handlerFn) {
								terminalInputHandler = undefined;
							}
						};
					},
				},
				sessionManager: {
					getSessionFile: () => alphaSession,
					getBranch: () => [],
				},
			} as any);
		}

		assert.ok(terminalInputHandler, "opening a subagent through /subagents should enable runtime ctrl+b back navigation");
		assert.deepEqual(terminalInputHandler!("\u0002"), { data: "/subagents-back\n" });

		await backCommand!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async (sessionPath: string) => {
				switchedSessions.push(sessionPath);
				return { cancelled: false };
			},
			ui: { notify: () => {} },
			sessionManager: {
				getSessionFile: () => alphaSession,
				getBranch: () => [],
			},
		} as any);

		assert.deepEqual(switchedSessions, [alphaSession, parentSession]);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("fresh runtime in a thread session should not install ctrl+b back navigation without runtime parent context", async () => {
	const projectDir = makeTempProject();
	const threadSession = path.join(projectDir, ".pi", "threads", "orphan.jsonl");

	try {
		fs.mkdirSync(path.dirname(threadSession), { recursive: true });
		fs.writeFileSync(threadSession, "{\"type\":\"session\"}\n", "utf8");

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const sessionStartHandlers = fakePi.events.get("session_start") ?? [];
		assert.equal(sessionStartHandlers.length > 0, true, "session_start handler should be registered");

		let terminalInputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const widgets = new Map<string, unknown>();
		const ui = {
			notify: () => {},
			setStatus: () => {},
			setWidget: (key: string, content: unknown) => {
				widgets.set(key, content);
			},
			theme: {
				fg: (_color: string, text: string) => text,
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
				terminalInputHandler = handler;
				return () => {
					if (terminalInputHandler === handler) {
						terminalInputHandler = undefined;
					}
				};
			},
		};

		for (const handler of sessionStartHandlers) {
			await handler({}, {
				cwd: projectDir,
				hasUI: true,
				ui,
				sessionManager: {
					getSessionFile: () => threadSession,
					getBranch: () => [],
				},
			} as any);
		}

		assert.equal(terminalInputHandler, undefined);
		assert.deepEqual(widgets.get("pi-threads-subagent-banner"), [
			"Subagent [orphan]  parent current runtime only",
			"/subagents to switch threads",
		]);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("session_before_switch should block entering a subagent while the current parent dispatch is still active", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(alphaSession, [{ type: "session", version: 3, cwd: projectDir }]);
		fs.mkdirSync(path.join(projectDir, ".pi", "threads"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify({ enabled: true }, null, 2) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const beforeSwitchHandlers = fakePi.events.get("session_before_switch") ?? [];
		assert.ok(dispatch, "dispatch tool should be registered");
		assert.equal(beforeSwitchHandlers.length > 0, true, "session_before_switch handler should be registered");

		let resolveRun!: (value: unknown) => void;
		const originalInvoke = ThreadSupervisor.prototype.invoke;
		ThreadSupervisor.prototype.invoke = function () {
			return {
				runId: "run-1",
				thread: "alpha",
				result: new Promise((resolve) => {
					resolveRun = resolve;
				}),
				cancel: async () => {},
				subscribe: () => () => {},
				getSnapshot: () => ({
					runId: "run-1",
					thread: "alpha",
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		const dispatchExecution = dispatch!.execute(
			"tool-call-1",
			{ thread: "alpha", action: "Inspect alpha" },
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

		try {
			await Promise.resolve();

			const guardResults = await Promise.all(beforeSwitchHandlers.map((handler) => handler(
				{ type: "session_before_switch", reason: "resume", targetSessionFile: alphaSession },
				{
					cwd: projectDir,
					hasUI: true,
					ui: { notify: () => {} },
					sessionManager: {
						getSessionFile: () => parentSession,
						getBranch: () => [],
					},
				} as any,
			)));

			assert.deepEqual(guardResults, [{ cancel: true }]);
		} finally {
			resolveRun({
				runId: "run-1",
				thread: "alpha",
				finalState: { tag: "exited", exitCode: 0, signal: null },
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: "openai-codex/gpt-5.4",
			});
			await dispatchExecution;
			ThreadSupervisor.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("session_before_switch should block leaving a subagent while its remembered parent dispatch is still active", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(alphaSession, [
			{ type: "session", version: 3, cwd: projectDir },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "alpha ready" }],
				},
			},
		]);
		fs.mkdirSync(path.join(projectDir, ".pi", "threads"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify({ enabled: true }, null, 2) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		const beforeSwitchHandlers = fakePi.events.get("session_before_switch") ?? [];
		assert.ok(dispatch, "dispatch tool should be registered");
		assert.ok(subagents, "/subagents should be registered");
		assert.equal(beforeSwitchHandlers.length > 0, true, "session_before_switch handler should be registered");

		await subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify: () => {},
				custom: async () => ({
					thread: "alpha",
					sessionPath: alphaSession,
					latestAction: "Inspect alpha",
					outputPreview: "alpha ready",
					toolPreview: "",
					accumulatedCost: 0.02,
					status: "done",
				}),
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "dispatch",
						details: {
							mode: "single",
							items: [{
								thread: "alpha",
								action: "Inspect alpha",
								episode: "alpha ready",
								episodeNumber: 1,
								result: {
									exitCode: 0,
									stderr: "",
									messages: [{ role: "assistant", content: [{ type: "text", text: "alpha ready" }] }],
									usage: {
										input: 12,
										output: 8,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0.02,
										contextTokens: 20,
										turns: 1,
									},
									sessionPath: alphaSession,
									isNewThread: false,
								},
							}],
						},
					},
				}],
			},
		} as any);

		let resolveRun!: (value: unknown) => void;
		const originalInvoke = ThreadSupervisor.prototype.invoke;
		ThreadSupervisor.prototype.invoke = function () {
			return {
				runId: "run-2",
				thread: "alpha",
				result: new Promise((resolve) => {
					resolveRun = resolve;
				}),
				cancel: async () => {},
				subscribe: () => () => {},
				getSnapshot: () => ({
					runId: "run-2",
					thread: "alpha",
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		const dispatchExecution = dispatch!.execute(
			"tool-call-2",
			{ thread: "alpha", action: "Inspect alpha again" },
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

		try {
			await Promise.resolve();

			const guardResults = await Promise.all(beforeSwitchHandlers.map((handler) => handler(
				{ type: "session_before_switch", reason: "resume", targetSessionFile: parentSession },
				{
					cwd: projectDir,
					hasUI: true,
					ui: { notify: () => {} },
					sessionManager: {
						getSessionFile: () => alphaSession,
						getBranch: () => [],
					},
				} as any,
			)));

			assert.deepEqual(guardResults, [{ cancel: true }]);
		} finally {
			resolveRun({
				runId: "run-2",
				thread: "alpha",
				finalState: { tag: "exited", exitCode: 0, signal: null },
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: "openai-codex/gpt-5.4",
			});
			await dispatchExecution;
			ThreadSupervisor.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should warn if the switch is cancelled because the parent dispatch is still active", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(alphaSession, [{ type: "session", version: 3, cwd: projectDir }]);
		fs.mkdirSync(path.join(projectDir, ".pi", "threads"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify({ enabled: true }, null, 2) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		assert.ok(dispatch, "dispatch tool should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let resolveRun!: (value: unknown) => void;
		const originalInvoke = ThreadSupervisor.prototype.invoke;
		ThreadSupervisor.prototype.invoke = function () {
			return {
				runId: "run-enter-cancel",
				thread: "alpha",
				result: new Promise((resolve) => {
					resolveRun = resolve;
				}),
				cancel: async () => {},
				subscribe: () => () => {},
				getSnapshot: () => ({
					runId: "run-enter-cancel",
					thread: "alpha",
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		const dispatchExecution = dispatch!.execute(
			"tool-call-enter-cancel",
			{ thread: "alpha", action: "Inspect alpha" },
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

		try {
			await Promise.resolve();

			const notifications: Array<{ message: string; level?: string }> = [];
			const switchedSessions: string[] = [];
			await subagents!.handler("", {
				cwd: projectDir,
				hasUI: true,
				switchSession: async (sessionPath: string) => {
					switchedSessions.push(sessionPath);
					return { cancelled: true };
				},
				ui: {
					notify: (message: string, level?: string) => {
						notifications.push({ message, level });
					},
					custom: async () => ({
						thread: "alpha",
						sessionPath: alphaSession,
						latestAction: "Inspect alpha",
						outputPreview: "(running...)",
						toolPreview: "$ sleep 75",
						accumulatedCost: 0,
						status: "unknown",
					}),
				},
				sessionManager: {
					getSessionFile: () => parentSession,
					getBranch: () => [],
				},
			} as any);

			assert.deepEqual(switchedSessions, [alphaSession]);
			assert.deepEqual(notifications, [{
				message: "Blocked session switch: parent dispatch is still running in parent.jsonl. Switching into or out of a subagent now would stop that in-flight dispatch. Wait for the dispatch to finish, then try again.",
				level: "warning",
			}]);
		} finally {
			resolveRun({
				runId: "run-enter-cancel",
				thread: "alpha",
				finalState: { tag: "exited", exitCode: 0, signal: null },
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: "openai-codex/gpt-5.4",
			});
			await dispatchExecution;
			ThreadSupervisor.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents-back should warn if the return switch is cancelled because the parent dispatch is still active", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(alphaSession, [
			{ type: "session", version: 3, cwd: projectDir },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "alpha ready" }],
				},
			},
		]);
		fs.mkdirSync(path.join(projectDir, ".pi", "threads"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify({ enabled: true }, null, 2) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		const backCommand = fakePi.commands.get("subagents-back");
		assert.ok(dispatch, "dispatch tool should be registered");
		assert.ok(subagents, "/subagents should be registered");
		assert.ok(backCommand, "/subagents-back should be registered");

		await subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify: () => {},
				custom: async () => ({
					thread: "alpha",
					sessionPath: alphaSession,
					latestAction: "Inspect alpha",
					outputPreview: "alpha ready",
					toolPreview: "",
					accumulatedCost: 0.02,
					status: "done",
				}),
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "dispatch",
						details: {
							mode: "single",
							items: [{
								thread: "alpha",
								action: "Inspect alpha",
								episode: "alpha ready",
								episodeNumber: 1,
								result: {
									exitCode: 0,
									stderr: "",
									messages: [{ role: "assistant", content: [{ type: "text", text: "alpha ready" }] }],
									usage: {
										input: 12,
										output: 8,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0.02,
										contextTokens: 20,
										turns: 1,
									},
									sessionPath: alphaSession,
									isNewThread: false,
								},
							}],
						},
					},
				}],
			},
		} as any);

		let resolveRun!: (value: unknown) => void;
		const originalInvoke = ThreadSupervisor.prototype.invoke;
		ThreadSupervisor.prototype.invoke = function () {
			return {
				runId: "run-back-cancel",
				thread: "alpha",
				result: new Promise((resolve) => {
					resolveRun = resolve;
				}),
				cancel: async () => {},
				subscribe: () => () => {},
				getSnapshot: () => ({
					runId: "run-back-cancel",
					thread: "alpha",
					pid: undefined,
					startedAt: Date.now(),
					state: { tag: "running" },
				}),
			} as any;
		};

		const dispatchExecution = dispatch!.execute(
			"tool-call-back-cancel",
			{ thread: "alpha", action: "Inspect alpha again" },
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

		try {
			await Promise.resolve();

			const notifications: Array<{ message: string; level?: string }> = [];
			const switchedSessions: string[] = [];
			await backCommand!.handler("", {
				cwd: projectDir,
				hasUI: true,
				switchSession: async (sessionPath: string) => {
					switchedSessions.push(sessionPath);
					return { cancelled: true };
				},
				ui: {
					notify: (message: string, level?: string) => {
						notifications.push({ message, level });
					},
				},
				sessionManager: {
					getSessionFile: () => alphaSession,
					getBranch: () => [],
				},
			} as any);

			assert.deepEqual(switchedSessions, [parentSession]);
			assert.deepEqual(notifications, [{
				message: "Blocked session switch: parent dispatch is still running in parent.jsonl. Switching into or out of a subagent now would stop that in-flight dispatch. Wait for the dispatch to finish, then try again.",
				level: "warning",
			}]);
		} finally {
			resolveRun({
				runId: "run-back-cancel",
				thread: "alpha",
				finalState: { tag: "exited", exitCode: 0, signal: null },
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: "openai-codex/gpt-5.4",
			});
			await dispatchExecution;
			ThreadSupervisor.prototype.invoke = originalInvoke;
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
