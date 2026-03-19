import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PiRunBackend } from "../../src/backends/pi-run-backend";

interface RunWindow {
	start: number;
	end: number;
}

const WORKER_SCRIPT = `
const fs = require("node:fs");
const markerPath = process.argv[1];
const runId = process.argv[2];
const delayMs = Number(process.argv[3]);

fs.appendFileSync(markerPath, "start " + runId + " " + Date.now() + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "completed " + runId }]
  }
}) + "\\n");

setTimeout(() => {
  fs.appendFileSync(markerPath, "end " + runId + " " + Date.now() + "\\n");
  process.exit(0);
}, delayMs);
`;

function parseWindows(markerFilePath: string): Map<string, RunWindow> {
	const windows = new Map<string, RunWindow>();
	const content = fs.readFileSync(markerFilePath, "utf8").trim();
	if (!content) return windows;

	for (const line of content.split("\n")) {
		const [kind, runId, rawTimestamp] = line.trim().split(/\s+/);
		const timestamp = Number(rawTimestamp);
		if (!kind || !runId || Number.isNaN(timestamp)) continue;

		const existing = windows.get(runId) ?? { start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY };
		if (kind === "start") existing.start = timestamp;
		if (kind === "end") existing.end = timestamp;
		windows.set(runId, existing);
	}

	return windows;
}

test("PiRunBackend serializes same-thread runs but keeps different threads concurrent", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-backend-"));
	const markerFilePath = path.join(tmpDir, "markers.log");
	const delayMs = 180;

	const backend = new PiRunBackend({
		command: process.execPath,
		buildArgs: (request) => ["-e", WORKER_SCRIPT, markerFilePath, request.runId, String(delayMs)],
	});

	try {
		const [sameA, sameB] = await Promise.all([
			backend.run({ runId: "same-A", cwd: tmpDir, action: "noop", sessionKey: "same-thread" }),
			backend.run({ runId: "same-B", cwd: tmpDir, action: "noop", sessionKey: "same-thread" }),
		]);

		assert.equal(sameA.finalState.tag, "exited");
		assert.equal(sameB.finalState.tag, "exited");
		assert.equal(sameA.messages.length > 0, true);
		assert.equal(sameB.messages.length > 0, true);

		const sameWindows = parseWindows(markerFilePath);
		const sameRuns = [sameWindows.get("same-A"), sameWindows.get("same-B")];
		assert.equal(sameRuns[0] !== undefined, true);
		assert.equal(sameRuns[1] !== undefined, true);

		const [firstRun, secondRun] = (sameRuns as RunWindow[]).sort((a, b) => a.start - b.start);
		assert.equal(Number.isFinite(firstRun.start), true);
		assert.equal(Number.isFinite(firstRun.end), true);
		assert.equal(Number.isFinite(secondRun.start), true);
		assert.equal(Number.isFinite(secondRun.end), true);
		assert.equal(
			secondRun.start >= firstRun.end,
			true,
			`Expected same-thread serialization, got first=[${firstRun.start},${firstRun.end}] second=[${secondRun.start},${secondRun.end}]`,
		);

		fs.writeFileSync(markerFilePath, "", "utf8");

		await Promise.all([
			backend.run({ runId: "diff-A", cwd: tmpDir, action: "noop", sessionKey: "thread-a" }),
			backend.run({ runId: "diff-B", cwd: tmpDir, action: "noop", sessionKey: "thread-b" }),
		]);

		const diffWindows = parseWindows(markerFilePath);
		const diffA = diffWindows.get("diff-A");
		const diffB = diffWindows.get("diff-B");
		assert.equal(diffA !== undefined, true);
		assert.equal(diffB !== undefined, true);

		const overlapStart = Math.max((diffA as RunWindow).start, (diffB as RunWindow).start);
		const overlapEnd = Math.min((diffA as RunWindow).end, (diffB as RunWindow).end);
		assert.equal(
			overlapEnd > overlapStart,
			true,
			`Expected different-thread overlap, got diff-A=[${(diffA as RunWindow).start},${(diffA as RunWindow).end}] diff-B=[${(diffB as RunWindow).start},${(diffB as RunWindow).end}]`,
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
