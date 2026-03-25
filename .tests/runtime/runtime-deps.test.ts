import assert from "node:assert/strict";
import test from "node:test";

import { createSearchInput } from "../../src/pi/runtime-deps";
import { makeTheme } from "../helpers/subagent-test-helpers";

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
