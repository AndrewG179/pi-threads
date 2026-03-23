import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function makeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};
}

test("SubagentSelector matches raw keys through the current tui.select.* runtime ids", () => {
	const tui = require("@mariozechner/pi-tui") as {
		getKeybindings?: () => { matches(input: string, command: string): boolean };
		getEditorKeybindings?: () => { matches(input: string, command: string): boolean };
	};

	const originalGetKeybindings = tui.getKeybindings;
	tui.getKeybindings = () => ({
		matches(input: string, command: string) {
			const commands: Record<string, string[]> = {
				"tui.select.up": ["up", "k"],
				"tui.select.down": ["down", "j"],
				"tui.select.confirm": ["enter"],
				"tui.select.cancel": ["escape"],
			};
			return (commands[command] ?? []).includes(input);
		},
	});

	try {
		const { SubagentSelector } = require("../../src/subagents/selector") as typeof import("../../src/subagents/selector");
		const selected: string[] = [];
		const selector = new SubagentSelector(
			[
				{
					thread: "alpha",
					sessionPath: "/tmp/alpha.jsonl",
					latestAction: "first",
					outputPreview: "alpha",
					toolPreview: "",
					accumulatedCost: 0,
					status: "unknown",
				},
				{
					thread: "beta",
					sessionPath: "/tmp/beta.jsonl",
					latestAction: "second",
					outputPreview: "beta",
					toolPreview: "",
					accumulatedCost: 0,
					status: "unknown",
				},
			],
			makeTheme(),
			(result) => {
				if (result) selected.push(result.thread);
			},
		);

		selector.handleInput("down");
		selector.handleInput("enter");

		assert.deepEqual(
			selected,
			["beta"],
			"selector should respond to raw TUI keys through the runtime tui.select.* command ids instead of stale select* ids",
		);
	} finally {
		tui.getKeybindings = originalGetKeybindings;
	}
});
