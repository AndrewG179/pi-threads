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

test("dispatch should remember the parent session for spawned thread sessions", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const threadSession = path.join(projectDir, ".pi", "threads", "smoke-fast.jsonl");

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
		} finally {
			ThreadSupervisor.prototype.invoke = originalInvoke;
		}

		const statePath = path.join(projectDir, ".pi", "threads", "state.json");
		const state = loadThreadsState(projectDir);
		assert.equal(fs.existsSync(statePath), true);
		assert.deepEqual(state.parentBySession[threadSession], parentSession);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents-back should work from a plain command ExtensionContext shape", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const threadSession = path.join(projectDir, ".pi", "threads", "smoke-fast.jsonl");

	try {
		fs.mkdirSync(path.dirname(parentSession), { recursive: true });
		fs.writeFileSync(parentSession, "{\"type\":\"session\"}\n", "utf8");
		fs.mkdirSync(path.dirname(threadSession), { recursive: true });
		fs.writeFileSync(threadSession, "{\"type\":\"session\"}\n", "utf8");
		fs.mkdirSync(path.join(projectDir, ".pi", "threads"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify(
				{
					enabled: true,
					parentBySession: {
						[path.resolve(threadSession)]: path.resolve(parentSession),
					},
				},
				null,
				2,
			) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const backCommand = fakePi.commands.get("subagents-back");
		assert.ok(backCommand, "/subagents-back command should be registered");

		await assert.doesNotReject(async () => {
			await backCommand!.handler("", {
				cwd: projectDir,
				hasUI: true,
				ui: { notify: () => {} },
				sessionManager: {
					getSessionFile: () => threadSession,
					getBranch: () => [],
				},
				modelRegistry: {},
				model: undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
			} as any);
		});
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("fresh runtime should install restart-safe ctrl+b back navigation for remembered subagent sessions", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const threadSession = path.join(projectDir, ".pi", "threads", "smoke-fast.jsonl");

	try {
		fs.mkdirSync(path.dirname(parentSession), { recursive: true });
		fs.writeFileSync(parentSession, "{\"type\":\"session\"}\n", "utf8");
		fs.mkdirSync(path.dirname(threadSession), { recursive: true });
		fs.writeFileSync(threadSession, "{\"type\":\"session\"}\n", "utf8");
		fs.mkdirSync(path.join(projectDir, ".pi", "threads"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify(
				{
					enabled: true,
					parentBySession: {
						[path.resolve(threadSession)]: path.resolve(parentSession),
					},
				},
				null,
				2,
			) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const sessionStartHandlers = fakePi.events.get("session_start") ?? [];
		assert.equal(sessionStartHandlers.length > 0, true, "session_start handler should be registered");

		let terminalInputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const ui = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
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

		assert.ok(
			terminalInputHandler,
			"fresh runtimes should install a restart-safe terminal-input back-navigation path",
		);
		assert.deepEqual(terminalInputHandler!("\u0002"), { data: "/subagents-back\n" });
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("subagent sessions without remembered parents should not install a ctrl+b terminal rewrite", async () => {
	const projectDir = makeTempProject();
	const threadSession = path.join(projectDir, ".pi", "threads", "orphan.jsonl");

	try {
		fs.mkdirSync(path.dirname(threadSession), { recursive: true });
		fs.writeFileSync(threadSession, "{\"type\":\"session\"}\n", "utf8");
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify(
				{
					enabled: true,
					parentBySession: {},
				},
				null,
				2,
			) + "\n",
			"utf8",
		);

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

		assert.equal(
			terminalInputHandler,
			undefined,
			"subagent sessions without remembered parents should not advertise an unusable terminal-input ctrl+b path",
		);
		assert.deepEqual(widgets.get("pi-threads-subagent-banner"), [
			"Subagent [orphan]  parent unknown",
			"/subagents to switch threads",
		]);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("BR-010 should route back navigation through /subagents-back only", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const threadSession = path.join(projectDir, ".pi", "threads", "child.jsonl");

	try {
		fs.mkdirSync(path.dirname(parentSession), { recursive: true });
		fs.writeFileSync(parentSession, "{\"type\":\"session\"}\n", "utf8");
		fs.mkdirSync(path.dirname(threadSession), { recursive: true });
		fs.writeFileSync(threadSession, "{\"type\":\"session\"}\n", "utf8");
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify(
				{
					enabled: true,
					parentBySession: {
						[path.resolve(threadSession)]: path.resolve(parentSession),
					},
				},
				null,
				2,
			) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const sessionStartHandlers = fakePi.events.get("session_start") ?? [];
		const backCommand = fakePi.commands.get("subagents-back");
		assert.ok(backCommand, "/subagents-back command should be registered");
		assert.equal(fakePi.shortcuts.get("ctrl+b"), undefined, "ctrl+b should not be registered twice through the shortcut API");

		const notifications: Array<{ message: string; level?: string }> = [];
		let terminalInputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const ctx = {
			cwd: projectDir,
			hasUI: true,
			ui: {
				notify: (message: string, level?: string) => {
					notifications.push({ message, level });
				},
				setStatus: () => {},
				setWidget: () => {},
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
			},
			sessionManager: {
				getSessionFile: () => threadSession,
				getBranch: () => [],
			},
			switchSession: async () => ({ cancelled: false }),
			modelRegistry: {},
			model: undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		};

		for (const handler of sessionStartHandlers) {
			await handler({}, ctx as any);
		}

		assert.ok(terminalInputHandler, "remembered subagent sessions should still install the terminal ctrl+b rewrite");
		assert.deepEqual(terminalInputHandler!("\u0002"), { data: "/subagents-back\n" });
		await assert.doesNotReject(async () => {
			await backCommand.handler("", ctx as any);
		});
		assert.deepEqual(notifications, []);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
