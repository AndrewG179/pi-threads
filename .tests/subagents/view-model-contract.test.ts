import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { Container, Text } from "@mariozechner/pi-tui";

import { default as registerExtension } from "../../index";

type RegisteredTool = {
	name: string;
	renderResult?: (result: Record<string, unknown>, controls: { expanded: boolean }, theme: ReturnType<typeof makeTheme>) => unknown;
};

type RegisteredCommand = {
	handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

type RegisteredShortcut = {
	handler: (ctx: Record<string, unknown>) => Promise<void> | void;
};

function makeTempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-view-model-"));
}

function makeFakePi() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts = new Map<string, RegisteredShortcut>();

	return {
		on: () => {},
		registerCommand(name: string, config: RegisteredCommand) {
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
		commands,
		shortcuts,
	};
}

function makeTheme() {
	return {
		bold: (text: string) => text,
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

function makeDispatchItem(thread: string, episode: string) {
	return {
		thread,
		action: `Inspect ${thread}`,
		episode,
		episodeNumber: 1,
		result: {
			thread,
			action: `Inspect ${thread}`,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: {
				input: 12,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.02,
				contextTokens: 20,
				turns: 1,
			},
			model: "openai-codex/gpt-5.4",
			sessionPath: `/tmp/${thread}.jsonl`,
			isNewThread: false,
		},
	};
}

function flattenRenderedLines(component: unknown, width = 120): string[] {
	if (!component || typeof component !== "object") return [];
	if (component instanceof Container) {
		return component.children.flatMap((child) => flattenRenderedLines(child, width));
	}
	if (component instanceof Text) {
		return component.render(width);
	}
	if ("render" in component && typeof component.render === "function") {
		return component.render(width);
	}
	if ("children" in component && Array.isArray(component.children)) {
		return component.children.flatMap((child: unknown) => flattenRenderedLines(child, width));
	}
	return [];
}

test("/subagents should open an independent custom view instead of a modal overlay", async () => {
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
		assert.ok(subagents, "/subagents should be registered");

		let customRenderer: ((...args: any[]) => unknown) | undefined;
		let customOptions: Record<string, unknown> | undefined;

		await subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify: () => {},
				custom: async (renderer: (...args: any[]) => unknown, options?: Record<string, unknown>) => {
					customRenderer = renderer;
					customOptions = options;
					return undefined;
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

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");
		assert.equal(customOptions?.overlay, true, "/subagents should mount as a fullscreen overlay to cover prior transcript content");
		assert.equal(customOptions?.overlayOptions?.anchor, "top-left");
		assert.equal(customOptions?.overlayOptions?.width, "100%");
		assert.equal(customOptions?.overlayOptions?.maxHeight, "100%");
		assert.equal(customOptions?.overlayOptions?.margin, 0);

		const rendered = flattenRenderedLines(customRenderer!(undefined, makeTheme(), undefined, () => {}), 80).join("\n");
		assert.match(rendered, /\[alpha\]/, "the subagent view should still render subagent card summaries from collected card data");
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents browser should keep navigation and selected-detail panes visible together above the fold instead of stacking the full list first", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const threadNames = ["alpha", "beta", "gamma", "delta"];

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		for (const thread of threadNames) {
			writeThreadSession(path.join(projectDir, ".pi", "threads", `${thread}.jsonl`), [
				{ type: "session", version: 3, cwd: projectDir },
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: `Inspect ${thread} implementation details` }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${thread} preview output with enough detail to wrap across lines.` }],
					},
				},
			]);
		}

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		assert.ok(subagents, "/subagents should be registered");

		let customRenderer: ((...args: any[]) => unknown) | undefined;

		await subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify: () => {},
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
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
							items: threadNames.map((thread) => ({
								thread,
								action: `Inspect ${thread} implementation details with a longer action summary`,
								episode: `${thread} ready`,
								episodeNumber: 1,
								result: {
									exitCode: 0,
									stderr: "",
									messages: [{ role: "assistant", content: [{ type: "text", text: `${thread} ready` }] }],
									usage: {
										input: 12,
										output: 8,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0.02,
										contextTokens: 20,
										turns: 1,
									},
									sessionPath: path.join(projectDir, ".pi", "threads", `${thread}.jsonl`),
									isNewThread: false,
								},
							})),
						},
					},
				}],
			},
		} as any);

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");

		const renderedLines = flattenRenderedLines(customRenderer!(undefined, makeTheme(), undefined, () => {}), 72);
		const constrainedViewport = renderedLines.slice(0, 8).join("\n");

		assert.match(constrainedViewport, /Subagents/, "the browser title should remain visible in a constrained viewport");
		assert.match(constrainedViewport, /Sessions/, "the navigation-pane header should remain visible in a constrained viewport");
		assert.match(
			constrainedViewport,
			/Selected/,
			"the selected-detail pane header should stay above the fold rather than being pushed below a stacked list of sessions",
		);
		assert.match(
			constrainedViewport,
			/Action/,
			"the selected-detail pane should keep its top section visible even if lower detail is truncated by viewport height",
		);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents browser should render a full editor-height frame so stale transcript rows are not left behind in the replaced region", async () => {
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
		assert.ok(subagents, "/subagents should be registered");

		let customRenderer: ((...args: any[]) => unknown) | undefined;

		await subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify: () => {},
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
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

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");

		const editorHeight = 18;
		const renderedLines = flattenRenderedLines(
			customRenderer!({ terminal: { rows: editorHeight } }, makeTheme(), undefined, () => {}),
			80,
		);

		assert.match(renderedLines[0] ?? "", /Subagents/, "the browser header should start at the top of the replaced editor region");
		assert.equal(
			renderedLines.length,
			editorHeight,
			"the standalone browser should render enough rows to fully replace the editor region; shorter output leaves stale prior content visible around the browser",
		);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("standalone /subagents browser should use the keybindings object supplied by ctx.ui.custom() for navigation and selection", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");
	const betaSession = path.join(projectDir, ".pi", "threads", "beta.jsonl");

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
		writeThreadSession(betaSession, [
			{ type: "session", version: 3, cwd: projectDir },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "beta ready" }],
				},
			},
		]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		assert.ok(subagents, "/subagents should be registered");

		let customRenderer: ((...args: any[]) => unknown) | undefined;

		await subagents!.handler("", {
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify: () => {},
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
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
										usage: {
											input: 12,
											output: 8,
											cacheRead: 0,
											cacheWrite: 0,
											cost: 0.02,
											contextTokens: 20,
											turns: 1,
										},
										sessionPath: betaSession,
										isNewThread: false,
									},
								},
							],
						},
					},
				}],
			},
		} as any);

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");

		const keybindingCalls: Array<{ keyData: string; command: string }> = [];
		let selectedThread: string | undefined;
		const browser = customRenderer!(
			undefined,
			makeTheme(),
			{
				matches(keyData: string, command: string) {
					keybindingCalls.push({ keyData, command });
					return (
						(keyData === "custom-next" && command === "tui.select.down") ||
						(keyData === "custom-open" && command === "tui.select.confirm")
					);
				},
			},
			(result: { thread?: string } | undefined) => {
				selectedThread = result?.thread;
			},
		) as { handleInput?: (keyData: string) => void };

		assert.equal(typeof browser.handleInput, "function", "custom view should return an interactive browser with input handling");

		browser.handleInput!("custom-next");
		browser.handleInput!("custom-open");

		assert.deepEqual(
			keybindingCalls,
			[
				{ keyData: "custom-next", command: "tui.select.up" },
				{ keyData: "custom-next", command: "tui.select.down" },
				{ keyData: "custom-open", command: "tui.select.up" },
				{ keyData: "custom-open", command: "tui.select.down" },
				{ keyData: "custom-open", command: "tui.select.confirm" },
			],
			"the standalone browser should query the ctx.ui.custom() keybindings object for its navigation commands",
		);
		assert.equal(
			selectedThread,
			"beta",
			"the standalone browser should navigate and confirm using the supplied keybindings instead of a separate global keybinding export",
		);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("ctrl+o should route into the standalone /subagents browser when shortcuts are available", async () => {
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

		const shortcut = fakePi.shortcuts.get("ctrl+o");
		assert.ok(shortcut, "ctrl+o should be registered as a /subagents browser entry path");

		let customRenderer: ((...args: any[]) => unknown) | undefined;
		let customOptions: Record<string, unknown> | undefined;

		await shortcut!.handler({
			cwd: projectDir,
			hasUI: true,
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify: () => {},
				custom: async (renderer: (...args: any[]) => unknown, options?: Record<string, unknown>) => {
					customRenderer = renderer;
					customOptions = options;
					return undefined;
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

		assert.ok(customRenderer, "ctrl+o should open the subagent browser");
		assert.equal(customOptions?.overlay, true, "ctrl+o should open the fullscreen browser overlay");
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("collapsed single dispatch chat rendering should stay lightweight and reject inline Ctrl+O expansion prompts", () => {
	const fakePi = makeFakePi();
	registerExtension(fakePi as any);

	const dispatch = fakePi.tools.get("dispatch");
	assert.ok(dispatch?.renderResult, "dispatch tool should expose renderResult");

	const component = dispatch!.renderResult!(
		{
			content: [{ type: "text", text: "[alpha] alpha finished" }],
			details: {
				mode: "single",
				items: [makeDispatchItem("alpha", "alpha finished")],
			},
		},
		{ expanded: false },
		makeTheme(),
	);

	assert.equal(
		component instanceof Text,
		true,
		"collapsed single dispatch output should stay a lightweight text summary instead of an expandable card container",
	);

	const rendered = flattenRenderedLines(component).join("\n");
	assert.doesNotMatch(
		rendered,
		/\(Ctrl\+O to expand\)/,
		"chat dispatch summaries should not advertise inline Ctrl+O expansion",
	);
});

test("collapsed batch dispatch chat rendering should not append the inline Ctrl+O expansion path", () => {
	const fakePi = makeFakePi();
	registerExtension(fakePi as any);

	const dispatch = fakePi.tools.get("dispatch");
	assert.ok(dispatch?.renderResult, "dispatch tool should expose renderResult");

	const rendered = flattenRenderedLines(
		dispatch!.renderResult!(
			{
				content: [{ type: "text", text: "[alpha] alpha finished\n\n[beta] beta finished" }],
				details: {
					mode: "batch",
					items: [makeDispatchItem("alpha", "alpha finished"), makeDispatchItem("beta", "beta finished")],
				},
			},
			{ expanded: false },
			makeTheme(),
		),
	).join("\n");

	assert.match(rendered, /\[alpha\]/, "batch chat rendering should still summarize dispatched threads");
	assert.match(rendered, /\[beta\]/, "batch chat rendering should still summarize dispatched threads");
	assert.doesNotMatch(
		rendered,
		/\(Ctrl\+O to expand\)/,
		"batch chat rendering should not expose the inline Ctrl+O expansion path",
	);
});
