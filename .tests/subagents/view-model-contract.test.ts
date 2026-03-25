import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";
import { Container, Text, visibleWidth } from "../../src/pi/runtime-deps";
import { PiActorRuntime } from "../../src/runtime/pi-actor";
import { SubagentBrowser } from "../../src/subagents/view";
import {
	makeCommandContext,
	makeFakePi,
	makeSelectKeybindings,
	makeTempProject,
	makeTheme,
	patchPiActorInvoke,
	writeThreadSession,
} from "../helpers/subagent-test-helpers";

const require = createRequire(path.join(process.cwd(), ".tests", "subagents", "view-model-contract.test.ts"));

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

test("/subagents should open an independent custom view instead of composing over the live transcript as a modal overlay", async () => {
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
		let customOptions: {
			overlay?: boolean;
			overlayOptions?: {
				anchor?: string;
				width?: string;
				maxHeight?: string;
				margin?: number;
			};
		} | undefined;

		await subagents!.handler("", makeCommandContext({
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
				custom: async (
					renderer: (...args: any[]) => unknown,
					options?: {
						overlay?: boolean;
						overlayOptions?: {
							anchor?: string;
							width?: string;
							maxHeight?: string;
							margin?: number;
						};
					},
				) => {
					customRenderer = renderer;
					customOptions = options;
					return undefined;
				},
			},
		}) as any);

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");
		assert.notEqual(
			customOptions?.overlay,
			true,
			"/subagents should use the replacement custom-view path; overlay mode composites over the live transcript instead of clearing it",
		);
		assert.equal(
			customOptions?.overlayOptions,
			undefined,
			"/subagents should not pass fullscreen overlay options when it is meant to replace the editor region",
		);

		const rendered = flattenRenderedLines(customRenderer!(undefined, makeTheme(), undefined, () => {}), 80).join("\n");
		assert.match(rendered, /\[alpha\]/, "the subagent view should still render subagent card summaries from collected card data");
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should list a just-dispatched in-flight thread from same-runtime registry data before a completed toolResult exists", async () => {
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
					content: [{ type: "text", text: "Inspect alpha while it is still running" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial progress" }],
				},
			},
		]);
		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const dispatch = fakePi.tools.get("dispatch");
		const subagents = fakePi.commands.get("subagents");
		assert.ok(dispatch?.execute, "dispatch should be registered");
		assert.ok(subagents, "/subagents should be registered");

		let customRenderer: ((...args: any[]) => unknown) | undefined;
		let resolveRun: ((value: unknown) => void) | undefined;
		const restoreInvoke = patchPiActorInvoke(function () {
			return {
				runId: "run-1",
				thread: "alpha",
				result: new Promise((resolve) => {
					resolveRun = resolve;
				}),
				cancel: async () => {},
				subscribe: () => () => {},
			} as any;
		} as typeof PiActorRuntime.prototype.invoke);

		const execution = dispatch.execute!(
			"tool-call-1",
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

		try {
			await Promise.resolve();

			await subagents!.handler("", makeCommandContext({
				cwd: projectDir,
				sessionFile: parentSession,
				branch: [],
				ui: {
					custom: async (renderer: (...args: any[]) => unknown) => {
						customRenderer = renderer;
						return undefined;
					},
				},
			}) as any);

			assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");

			const rendered = flattenRenderedLines(customRenderer!(undefined, makeTheme(), undefined, () => {}), 80).join("\n");
			assert.match(
				rendered,
				/\[alpha\]/,
				"a same-runtime in-flight dispatch should remain visible in /subagents before a completed toolResult is written",
			);
		} finally {
			resolveRun?.({
				runId: "run-1",
				thread: "alpha",
				finalState: { tag: "exited", exitCode: 0, signal: null },
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: "openai-codex/gpt-5.4",
			});
			await execution;
			restoreInvoke();
		}
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should ignore stale state.json parent linkage when no same-runtime run or completed dispatch result exists", async () => {
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
					content: [{ type: "text", text: "Inspect alpha while it is still running" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial progress" }],
				},
			},
		]);
		fs.mkdirSync(path.join(projectDir, ".pi", "threads"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi", "threads", "state.json"),
			JSON.stringify(
				{
					enabled: true,
					parentBySession: {
						[path.resolve(alphaSession)]: path.resolve(parentSession),
					},
				},
				null,
				2,
			) + "\n",
			"utf8",
		);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		assert.ok(subagents, "/subagents should be registered");

		let customRenderer: ((...args: any[]) => unknown) | undefined;

		await subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [{
				type: "message",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						name: "dispatch",
						arguments: {
							thread: "alpha",
							action: "Inspect alpha while it is still running",
						},
					}],
				},
			}],
			ui: {
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
				},
			},
		}) as any);

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");

		const rendered = flattenRenderedLines(customRenderer!(undefined, makeTheme(), undefined, () => {}), 80).join("\n");
		assert.match(
			rendered,
			/No subagent runs in this session\./,
			"live /subagents discovery should come from the runtime-owned run store or completed parent dispatch metadata, not stale parent linkage persisted in state.json",
		);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/subagents should ignore stray thread transcript files when there is no live runtime record or completed parent dispatch result", async () => {
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
					content: [{ type: "text", text: "alpha transcript output that should stay historical only" }],
				},
			},
		]);
		writeThreadSession(betaSession, [
			{ type: "session", version: 3, cwd: projectDir },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "beta transcript output that should stay historical only" }],
				},
			},
		]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		assert.ok(subagents, "/subagents should be registered");

		let customRenderer: ((...args: any[]) => unknown) | undefined;

		await subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [],
			ui: {
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
				},
			},
		}) as any);

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");

		const rendered = flattenRenderedLines(customRenderer!(undefined, makeTheme(), undefined, () => {}), 80).join("\n");
		assert.match(
			rendered,
			/No subagent runs in this session\./,
			"thread transcript files on disk are durable history, not live parent/child discovery authority for /subagents",
		);
		assert.doesNotMatch(
			rendered,
			/\[alpha\]|\[beta\]/,
			"historical thread transcript files should stay hidden until the current parent session owns a live run or a completed dispatch result for them",
		);
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

		await subagents!.handler("", makeCommandContext({
			cwd: projectDir,
			sessionFile: parentSession,
			branch: [{
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
			ui: {
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
				},
			},
		}) as any);

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

		await subagents!.handler("", makeCommandContext({
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
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
				},
			},
		}) as any);

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

test("/subagents browser selected pane should stay compact, preview-only, and avoid full-width selected-row styling", () => {
	const browser = new SubagentBrowser(
		() => [{
			thread: "loc-scan",
			sessionPath: "/tmp/loc-scan.jsonl",
			latestAction: Array.from({ length: 40 }, (_, index) => `ACTION-${String(index + 1).padStart(2, "0")}`).join(" "),
			outputLines: Array.from({ length: 12 }, (_, index) => `OUTPUT-${String(index + 1).padStart(2, "0")}`),
			outputPreview: "OUTPUT-12",
			outputTail: Array.from({ length: 12 }, (_, index) => `OUTPUT-${String(index + 1).padStart(2, "0")}`),
			toolPreview: "$ cloc index.ts src --include-lang=TypeScript --json && printf '\\n---\\n' && cloc .tests --include-lang=TypeScript --json",
			accumulatedCost: 0.17,
			status: "done",
		}],
		{ terminal: { rows: 24 } },
		{
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => `BG(${text})`,
		},
		makeSelectKeybindings(),
		() => {},
	);

	const rendered = browser.render(84).join("\n");
	assert.doesNotMatch(rendered, /BG\(/, "browser mode should not use background-styled full-width rows for the selected session");
	assert.match(rendered, /ACTION-01/, "the browser should still show the start of the selected action");
	assert.doesNotMatch(rendered, /ACTION-20/, "browser mode should not expose deep action detail before Enter opens the inspector");
	assert.match(rendered, /OUTPUT-12/, "the browser should show the latest output preview line");
	assert.doesNotMatch(rendered, /OUTPUT-06/, "browser mode should not dump older output tail lines");
	assert.match(rendered, /TypeScrip\.\.\./, "browser mode should keep the recent-tool row as a short truncated preview");
});

test("/subagents browser should stay summary-oriented instead of turning the selected pane into a partial inspector when many cards exist", () => {
	const longAction = "Work only in the worktree at /tmp/pi-threads-native-child-chat. Inspect index.ts plus the main subagents/dispatch files involved in native child opening: src/subagents/view.ts, src/subagents/runtime-store.ts, src/dispatch/supervisor.ts, and src/dispatch/journal.ts. Summarize the implemented architecture and flag any obvious code/documentation mismatches or remaining risky seams relevant to continuing subagents work.";
	const longOutput = [
		"## Bottom line",
		"As implemented today, the architecture is:",
		"- discovery/status = extension-owned session run store",
		"- background execution = detached supervisor + run journal",
		"- native child opening = browser returns sessionPath, then host switchSession(...)",
		"- survival across open-child navigation = abort-to-detach hack in the parent dispatch path",
	];

	const browser = new SubagentBrowser(
		() => [
			{
				thread: "subagents-code",
				sessionPath: "/tmp/subagents-code.jsonl",
				latestAction: longAction,
				outputLines: longOutput,
				outputPreview: longOutput[1],
				outputTail: longOutput,
				toolPreview: "read file",
				accumulatedCost: 0.10,
				status: "unknown",
			},
			{
				thread: "subagents-docs",
				sessionPath: "/tmp/subagents-docs.jsonl",
				latestAction: "Work only in the worktree at /tmp/pi-threads-native-child-chat. Read docs/README.md, docs/subagents.md, and docs/subagents-native-child-chat.md.",
				outputLines: ["docs note"],
				outputPreview: "docs note",
				outputTail: ["docs note"],
				toolPreview: "read file",
				accumulatedCost: 0.11,
				status: "unknown",
			},
			{
				thread: "subagents-gap",
				sessionPath: "/tmp/subagents-gap.jsonl",
				latestAction: "Does normal /resume already ignore .pi/threads child sessions?",
				outputLines: ["gap note"],
				outputPreview: "gap note",
				outputTail: ["gap note"],
				toolPreview: "read file",
				accumulatedCost: 0.12,
				status: "unknown",
			},
			{
				thread: "subagents-livedrive",
				sessionPath: "/tmp/subagents-livedrive.jsonl",
				latestAction: "Work only in the worktree at /tmp/pi-threads-native-child-chat. Live drive the new session behavior.",
				outputLines: ["livedrive note"],
				outputPreview: "livedrive note",
				outputTail: ["livedrive note"],
				toolPreview: "read file",
				accumulatedCost: 0.13,
				status: "unknown",
			},
			{
				thread: "subagents-resume",
				sessionPath: "/tmp/subagents-resume.jsonl",
				latestAction: "Cleanup now. Move...",
				outputLines: ["resume note"],
				outputPreview: "resume note",
				outputTail: ["resume note"],
				toolPreview: "read file",
				accumulatedCost: 0.14,
				status: "unknown",
			},
			{
				thread: "subagents-tests",
				sessionPath: "/tmp/subagents-tests.jsonl",
				latestAction: "Work only in the worktree at /tmp/pi-threads-native-child-chat. Inspect the subagents-related tests.",
				outputLines: ["tests note"],
				outputPreview: "tests note",
				outputTail: ["tests note"],
				toolPreview: "read file",
				accumulatedCost: 0.15,
				status: "unknown",
			},
		],
		{ terminal: { rows: 24 } },
		makeTheme(),
		makeSelectKeybindings(),
		() => {},
	);

	const rendered = browser.render(120).join("\n");
	assert.match(rendered, /\[subagents-code\]/, "the selected card should still be visible in the browser");
	assert.match(rendered, /\[subagents-tests\]/, "the browser should still keep the later session rows visible");
	assert.doesNotMatch(
		rendered,
		/switchSession\(\.\.\.\)/,
		"browser mode should stay summary-oriented; deep output detail belongs behind Enter inspect",
	);
	assert.doesNotMatch(
		rendered,
		/remaining risky seams relevant to continuing subagents work\./,
		"browser mode should not dump the later long-action detail of the selected card when many sessions exist",
	);
});

test("/subagents browser should request a re-render after navigation state changes", () => {
	let renderRequests = 0;
	const browser = new SubagentBrowser(
		() => [
			{
				thread: "alpha",
				sessionPath: "/tmp/alpha.jsonl",
				latestAction: "Inspect alpha",
				outputLines: ["alpha output"],
				outputPreview: "alpha output",
				outputTail: ["alpha output"],
				toolPreview: "read file",
				accumulatedCost: 0.01,
				status: "unknown",
			},
			{
				thread: "beta",
				sessionPath: "/tmp/beta.jsonl",
				latestAction: "Inspect beta",
				outputLines: ["beta output"],
				outputPreview: "beta output",
				outputTail: ["beta output"],
				toolPreview: "read file",
				accumulatedCost: 0.02,
				status: "unknown",
			},
		],
		{ terminal: { rows: 18 }, requestRender: () => { renderRequests++; } },
		makeTheme(),
		makeSelectKeybindings(),
		() => {},
	);

	browser.handleInput("DOWN");
	browser.handleInput("ENTER");
	browser.handleInput("DOWN");
	browser.handleInput("ESC");

	assert.equal(renderRequests, 4, "browser navigation and inspector transitions should trigger tui.requestRender() so the live view updates immediately");
});

test("/subagents inspector should scroll through the existing detail document instead of hard-capping section lines", () => {
	const browser = new SubagentBrowser(
		() => [{
			thread: "loc-scan",
			sessionPath: "/tmp/loc-scan.jsonl",
			latestAction: Array.from({ length: 60 }, (_, index) => `ACTION-${String(index + 1).padStart(2, "0")}`).join(" "),
			outputLines: Array.from({ length: 16 }, (_, index) => `OUTPUT-${String(index + 1).padStart(2, "0")}`),
			outputPreview: "OUTPUT-16",
			outputTail: Array.from({ length: 16 }, (_, index) => `OUTPUT-${String(index + 1).padStart(2, "0")}`),
			toolPreview: "$ cloc index.ts src --include-lang=TypeScript --json && printf '\\n---\\n' && cloc .tests --include-lang=TypeScript --json",
			accumulatedCost: 0.17,
			status: "done",
		}],
		{ terminal: { rows: 14 } },
		makeTheme(),
		makeSelectKeybindings(),
		() => {},
	);

	browser.handleInput("ENTER");
	const initial = browser.render(72).join("\n");
	assert.match(initial, /Subagent \[loc-scan\]/, "Enter should still open the inspector");
	assert.doesNotMatch(initial, /OUTPUT-16/, "the full detail document should not be visible without scrolling in a short inspector viewport");

	for (let index = 0; index < 20; index++) browser.handleInput("DOWN");

	const scrolled = browser.render(72).join("\n");
	assert.match(scrolled, /OUTPUT-16/, "scrolling the inspector should reveal later output lines from the existing detail document");
});

test("/subagents inspector should expose full completed output history instead of truncating to the last 8 lines", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const alphaSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);
		writeThreadSession(alphaSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const subagents = fakePi.commands.get("subagents");
		assert.ok(subagents, "/subagents should be registered");

		let browser: { handleInput?: (input: string) => void; render?: (width: number) => string[] } | undefined;
		await subagents!.handler("", makeCommandContext({
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
								messages: [{
									role: "assistant",
									content: [{
										type: "text",
										text: Array.from({ length: 16 }, (_, index) => `OUTPUT-${String(index + 1).padStart(2, "0")}`).join("\n"),
									}],
								}],
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
				custom: async (renderer: (...args: any[]) => unknown) => {
					browser = renderer(
						{ terminal: { rows: 18 } },
						makeTheme(),
						makeSelectKeybindings(),
						() => {},
					) as { handleInput?: (input: string) => void; render?: (width: number) => string[] };
					return undefined;
				},
			},
		}) as any);

		assert.equal(typeof browser?.handleInput, "function", "the subagent custom view should expose interactive input handling");

		browser!.handleInput!("ENTER");
		const initial = browser!.render!(72).join("\n");
		assert.match(initial, /OUTPUT-01/, "the inspector should include the start of the completed output history, not just the last 8 lines");

		for (let index = 0; index < 20; index++) browser!.handleInput!("DOWN");

		const scrolled = browser!.render!(72).join("\n");
		assert.match(scrolled, /OUTPUT-16/, "the inspector should still be able to reach the later output lines after scrolling");
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

		await subagents!.handler("", makeCommandContext({
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
			ui: {
				custom: async (renderer: (...args: any[]) => unknown) => {
					customRenderer = renderer;
					return undefined;
				},
			},
		}) as any);

		assert.ok(customRenderer, "/subagents should invoke ctx.ui.custom()");

		const keybindingCalls: Array<{ keyData: string; command: string }> = [];
		let closed = false;
		const browser = customRenderer!(
			undefined,
			makeTheme(),
			{
				matches(keyData: string, command: string) {
					keybindingCalls.push({ keyData, command });
					return (
						(keyData === "custom-next" && command === "tui.select.down") ||
						(keyData === "custom-open" && command === "tui.select.confirm") ||
						(keyData === "custom-close" && command === "tui.select.cancel")
					);
				},
			},
			() => {
				closed = true;
			},
		) as { handleInput?: (keyData: string) => void; render?: (width: number) => string[] };

		assert.equal(typeof browser.handleInput, "function", "custom view should return an interactive browser with input handling");

		browser.handleInput!("custom-next");
		browser.handleInput!("custom-open");

		assert.match(browser.render!(80).join("\n"), /Subagent \[beta\]/, "confirm should open the same-session inspector for the selected thread");
		assert.equal(
			keybindingCalls.some((call) => call.keyData === "custom-next" && call.command === "tui.select.down"),
			true,
			"the standalone browser should route navigation through the supplied keybindings object",
		);
		assert.equal(
			keybindingCalls.some((call) => call.keyData === "custom-open" && call.command === "tui.select.confirm"),
			true,
			"the standalone browser should route selection through the supplied keybindings object",
		);
		browser.handleInput!("custom-close");
		browser.handleInput!("custom-close");
		assert.equal(
			keybindingCalls.some((call) => call.keyData === "custom-close" && call.command === "tui.select.cancel"),
			true,
			"cancel should also flow through the supplied keybindings object",
		);
		assert.equal(closed, true, "cancel should back out of the inspector and then close the browser");
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("/model-sub picker should use the keybindings object supplied by ctx.ui.custom() for navigation and selection", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");

	try {
		writeThreadSession(parentSession, [{ type: "session", version: 3, cwd: projectDir }]);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const modelSub = fakePi.commands.get("model-sub");
		assert.ok(modelSub, "/model-sub should be registered");

		const pickerContext = {
			...makeCommandContext({
				cwd: projectDir,
				sessionFile: parentSession,
				branch: [],
				model: { provider: "openai-codex", id: "gpt-5.4" },
				ui: {
					custom: async (renderer: (...args: any[]) => unknown) => {
						let choice: unknown;
						const picker = renderer(
							{ requestRender: () => {} },
							makeTheme(),
							{
								matches(keyData: string, command: string) {
									return (
										(keyData === "custom-next" && command === "tui.select.down") ||
										(keyData === "custom-open" && command === "tui.select.confirm")
									);
								},
							},
							(result: unknown) => {
								choice = result;
							},
						) as { handleInput?: (keyData: string) => void };

						assert.equal(typeof picker.handleInput, "function", "model picker should expose interactive input handling");

						picker.handleInput!("custom-next");
						picker.handleInput!("custom-open");

						assert.deepEqual(
							choice,
							{ provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
							"the picker should move and confirm through the supplied keybindings object rather than raw escape sequences",
						);
						return choice;
					},
				},
			}),
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
					{ provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
				],
			},
		};

		await modelSub!.handler("", pickerContext as any);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("ctrl+o shortcut conflict should not be part of the extension contract", () => {
	const fakePi = makeFakePi();
	registerExtension(fakePi as any);

	assert.equal(
		fakePi.shortcuts.get("ctrl+o"),
		undefined,
		"the extension should not hard-register ctrl+o because the host already reserves that keybinding; /subagents should remain available through the explicit command contract instead",
	);
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

test("dispatch result rendering should not leave embedded newlines inside width-checked rows", () => {
	const fakePi = makeFakePi();
	registerExtension(fakePi as any);

	const dispatch = fakePi.tools.get("dispatch");
	assert.ok(dispatch?.renderResult, "dispatch tool should expose renderResult");

	const component = dispatch!.renderResult!(
		{
			content: [{ type: "text", text: "[l] (running...)" }],
			details: {
				mode: "single",
				items: [{
					thread: "l",
					action: "sleep 8;echo Z",
					episode: "(running...)",
					episodeNumber: 1,
					result: {
						thread: "l",
						action: "sleep 8;echo Z",
						exitCode: 0,
						messages: [],
						stderr: "",
						usage: {
							input: 2200,
							output: 118,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0.0055,
							contextTokens: 2300,
							turns: 1,
						},
						model: "openai-codex/gpt-5.3-codex",
						sessionPath: "/tmp/l.jsonl",
						isNewThread: true,
					},
				}],
			},
		},
		{ expanded: false },
		makeTheme(),
	);

	const renderedLines = flattenRenderedLines(component, 80);
	assert.ok(renderedLines.length > 0, "dispatch renderResult should emit at least one rendered row");
	for (const line of renderedLines) {
		assert.equal(
			line.includes("\n"),
			false,
			"dispatch renderResult should split multiline summaries before the host width-checks them",
		);
		assert.equal(
			visibleWidth(line) <= 80,
			true,
			`dispatch renderResult should keep each rendered row within the terminal width; got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
		);
	}
});

test("dispatch result rendering should keep the live running action-summary row within terminal width", () => {
	const fakePi = makeFakePi();
	registerExtension(fakePi as any);

	const dispatch = fakePi.tools.get("dispatch");
	assert.ok(dispatch?.renderResult, "dispatch tool should expose renderResult");

	const actionSummary = "Run bash command: sleep 8; echo Z. If it succeeds, report the final stdout token and whether the command completed successfully.";
	const terminalWidth = 120;
	const component = dispatch!.renderResult!(
		{
			content: [{ type: "text", text: "[live-alpha] (running...)" }],
			details: {
				mode: "single",
				items: [{
					thread: "live-alpha",
					action: actionSummary,
					episode: "(running...)",
					episodeNumber: 1,
					result: {
						thread: "live-alpha",
						action: actionSummary,
						exitCode: 0,
						messages: [],
						stderr: "",
						usage: {
							input: 2200,
							output: 77,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0.0067,
							contextTokens: 2300,
							turns: 1,
						},
						model: "openai-codex/gpt-5.4",
						sessionPath: "/tmp/live-alpha.jsonl",
						isNewThread: true,
					},
				}],
			},
		},
		{ expanded: false },
		makeTheme(),
	);

	const renderedLines = flattenRenderedLines(component, terminalWidth);
	const actionLine = renderedLines.find((line) => line.includes("Run bash command: sleep 8; echo Z."));
	assert.ok(actionLine, "dispatch renderResult should emit the live action-summary row");
	assert.equal(
		visibleWidth(actionLine) <= terminalWidth,
		true,
		`dispatch renderResult should wrap or truncate the live action-summary row to the terminal width; got ${visibleWidth(actionLine)} for ${JSON.stringify(actionLine)}`,
	);
});
