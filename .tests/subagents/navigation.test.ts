import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { PiActorRuntime } from "../../src/runtime/pi-actor";
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

		const originalInvoke = PiActorRuntime.prototype.invoke;
		PiActorRuntime.prototype.invoke = function () {
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
			PiActorRuntime.prototype.invoke = originalInvoke;
		}

		assert.deepEqual(loadThreadsState(projectDir), { enabled: false });
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should stay inside a same-session custom view and should not register back-navigation commands or shortcuts", async () => {
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

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		assert.ok(subagents, "/subagents should be registered");
		assert.equal(fakePi.commands.get("subagents-back"), undefined, "/subagents-back should be deleted in the same-session rewrite");
		assert.equal(fakePi.shortcuts.get("ctrl+b"), undefined, "ctrl+b should not be registered through the shortcut API");

		let browser:
			| {
					handleInput(input: string): void;
					render(width: number): string[];
			  }
			| undefined;
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
				custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) =>
					new Promise<unknown>((resolve) => {
						browser = factory(
							{ terminal: { rows: 24 } },
							{
								fg: (_color: string, text: string) => text,
								bg: (_color: string, text: string) => text,
							},
							makeSelectKeybindings(),
							resolve,
						) as { handleInput(input: string): void; render(width: number): string[] };
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

		await Promise.resolve();
		assert.ok(browser, "the subagent browser should open");
		assert.match(browser!.render(80).join("\n"), /Selected/);
		browser!.handleInput("ENTER");
		assert.match(browser!.render(80).join("\n"), /Subagent \[alpha\]/);
		assert.equal(switchCalls, 0, "inspecting a child should not call host switchSession");
		browser!.handleInput("ESC");
		browser!.handleInput("ESC");
		await handlerPromise;
		assert.equal(switchCalls, 0);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("fresh runtime in a thread session should not install a subagent banner or terminal back-navigation shim", async () => {
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
		assert.equal(widgets.get("pi-threads-subagent-banner"), undefined);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
