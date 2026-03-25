import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	loadThreadsState,
	saveThreadsState,
} from "../../src/subagents/state";

test("loadThreadsState defaults to disabled mode", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-state-default-"));

	try {
		assert.deepEqual(loadThreadsState(tmpDir), { enabled: false });
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("saveThreadsState persists only enabled mode", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-state-roundtrip-"));

	try {
		saveThreadsState(tmpDir, { enabled: true });

		assert.deepEqual(loadThreadsState(tmpDir), { enabled: true });
		const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "threads", "state.json"), "utf8"));
		assert.deepEqual(persisted, { enabled: true });
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
