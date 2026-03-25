import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { createSearchInput } from "../../src/pi/runtime-deps";
import { makeTheme } from "../helpers/subagent-test-helpers";

test("extension code should route host UI imports through runtime-deps", () => {
	for (const relativePath of ["index.ts", "src/subagents/view.ts", ".tests/subagents/view-model-contract.test.ts"]) {
		const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
		assert.doesNotMatch(
			source,
			/@mariozechner\/pi-tui|await import\("@mariozechner\/pi-coding-agent"\)/,
			`${relativePath} should use src/pi/runtime-deps instead of importing host UI modules directly`,
		);
	}
});

test("createSearchInput should adapt value-backed pi-tui inputs for /model-sub search filtering", () => {
	class ValueBackedInput {
		focused = false;
		value = "";

		constructor(
			_textRenderer?: (text: string) => string,
			_cursorRenderer?: (text: string) => string,
			_width?: number,
			_placeholder?: string,
		) {}

		handleInput(data: string): void {
			this.value += data;
		}

		render(): string[] {
			return [this.value];
		}

		invalidate(): void {}
	}

	const input = createSearchInput(makeTheme(), "ge", ValueBackedInput as any);

	assert.equal(
		input.getValue(),
		"ge",
		"the adapter should seed the initial search text even when the raw input only exposes a value field",
	);

	input.handleInput("m");

	assert.equal(
		input.getValue(),
		"gem",
		"the adapter should read the live search text from the raw input value field after typing",
	);
});
