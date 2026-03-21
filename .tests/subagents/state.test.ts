import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	loadThreadsState,
	rememberParentSession,
	saveThreadsState,
} from "../../src/subagents/state";

test("loadThreadsState defaults to disabled mode with no remembered parents", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-state-default-"));

	try {
		assert.deepEqual(loadThreadsState(tmpDir), {
			enabled: false,
			parentBySession: {},
		});
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("saveThreadsState persists enabled mode and parent-session mappings", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-state-roundtrip-"));
	const childSession = path.join(tmpDir, ".pi", "threads", "worker.jsonl");
	const parentSession = path.join(tmpDir, ".pi", "sessions", "parent.jsonl");

	try {
		const withParent = rememberParentSession(
			{ enabled: true, parentBySession: {} },
			childSession,
			parentSession,
		);

		saveThreadsState(tmpDir, withParent);

		assert.deepEqual(loadThreadsState(tmpDir), {
			enabled: true,
			parentBySession: {
				[childSession]: parentSession,
			},
		});
		assert.equal(fs.existsSync(path.join(tmpDir, ".pi", "threads", "state.json")), true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
