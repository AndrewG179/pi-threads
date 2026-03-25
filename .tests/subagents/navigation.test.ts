import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { PiActorRuntime } from "../../src/runtime/pi-actor";
import { loadThreadsState } from "../../src/subagents/state";
import {
	makeCommandContext,
	makeFakePi,
	makeSelectKeybindings,
	makeTempProject,
	patchPiActorInvoke,
	writeThreadSession,
} from "../helpers/subagent-test-helpers";

test("dispatch should not persist parent linkage in state.json", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		fs.mkdirSync(path.dirname(parentSession), { recursive: true });
		fs.writeFileSync(parentSession, "{\"type\":\"session\"}\n", "utf8");

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
					finalState: { tag: "exited", exitCode: 0, signal: null },
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					model: "openai-codex/gpt-5.4",
				}),
				cancel: async () => {},
				subscribe: () => () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		try {
			await dispatch.execute!(
				"tool-call-1",
				{ thread: "smoke-fast", action: "Respond with exactly: hello" },
				undefined,
				undefined,
				makeCommandContext({
					cwd: projectDir,
					sessionFile: parentSession,
					branch: [],
					model: { provider: "openai-codex", id: "gpt-5.4" },
				}) as any,
			);
		} finally {
			restoreInvoke();
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
		const handlerPromise = subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [{
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
			ui: {
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
		}) as any);

		await Promise.resolve();
		assert.ok(browser, "the subagent browser should open");
		assert.match(browser!.render(80).join("\n"), /Selected/);
		browser!.handleInput("ENTER");
		assert.match(browser!.render(80).join("\n"), /Subagent \[alpha\]/);
		browser!.handleInput("ESC");
		browser!.handleInput("ESC");
		await handlerPromise;
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
