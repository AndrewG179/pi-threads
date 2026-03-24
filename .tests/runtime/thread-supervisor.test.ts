import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PiActorRuntime } from "../../src/runtime/pi-actor";

interface RunWindow {
	start: number;
	end: number;
}

const WINDOW_WORKER_SCRIPT = `
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
	if (!fs.existsSync(markerFilePath)) return windows;

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

async function waitForRunStart(markerFilePath: string, runId: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const window = parseWindows(markerFilePath).get(runId);
		if (window && Number.isFinite(window.start)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`Timed out waiting for ${runId} to start`);
}

test("PiActorRuntime serializes same-session invocations while allowing different sessions to overlap", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-runtime-"));
	const markerFilePath = path.join(tmpDir, "markers.log");
	const delayMs = 180;

	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: (request) => ["-e", WINDOW_WORKER_SCRIPT, markerFilePath, request.runId, String(delayMs)],
	});

	try {
		const [sameA, sameB] = await Promise.all([
			runtime.invoke({ runId: "same-A", thread: "same-thread", cwd: tmpDir, action: "noop" }).result,
			runtime.invoke({ runId: "same-B", thread: "same-thread", cwd: tmpDir, action: "noop" }).result,
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
		assert.equal(
			secondRun.start >= firstRun.end,
			true,
			`Expected same-session serialization, got first=[${firstRun.start},${firstRun.end}] second=[${secondRun.start},${secondRun.end}]`,
		);

		fs.writeFileSync(markerFilePath, "", "utf8");

		await Promise.all([
			runtime.invoke({ runId: "diff-A", thread: "thread-a", cwd: tmpDir, action: "noop" }).result,
			runtime.invoke({ runId: "diff-B", thread: "thread-b", cwd: tmpDir, action: "noop" }).result,
		]);

		const diffWindows = parseWindows(markerFilePath);
		const diffA = diffWindows.get("diff-A") as RunWindow;
		const diffB = diffWindows.get("diff-B") as RunWindow;
		assert.equal(diffA !== undefined, true);
		assert.equal(diffB !== undefined, true);

		const overlapStart = Math.max(diffA.start, diffB.start);
		const overlapEnd = Math.min(diffA.end, diffB.end);
		assert.equal(
			overlapEnd > overlapStart,
			true,
			`Expected overlap for different sessions, got diff-A=[${diffA.start},${diffA.end}] diff-B=[${diffB.start},${diffB.end}]`,
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("PiActorRuntime allows matching thread names to overlap when they target different sessions", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-runtime-session-key-"));
	const markerFilePath = path.join(tmpDir, "markers.log");
	const cwdA = path.join(tmpDir, "cwd-a");
	const cwdB = path.join(tmpDir, "cwd-b");
	const delayMs = 180;

	fs.mkdirSync(cwdA, { recursive: true });
	fs.mkdirSync(cwdB, { recursive: true });

	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: (request) => ["-e", WINDOW_WORKER_SCRIPT, markerFilePath, request.runId, String(delayMs)],
	});

	try {
		await Promise.all([
			runtime.invoke({ runId: "same-name-a", thread: "shared-thread", cwd: cwdA, action: "noop" }).result,
			runtime.invoke({ runId: "same-name-b", thread: "shared-thread", cwd: cwdB, action: "noop" }).result,
		]);

		const windows = parseWindows(markerFilePath);
		const runA = windows.get("same-name-a") as RunWindow;
		const runB = windows.get("same-name-b") as RunWindow;
		assert.equal(runA !== undefined, true);
		assert.equal(runB !== undefined, true);

		const overlapStart = Math.max(runA.start, runB.start);
		const overlapEnd = Math.min(runA.end, runB.end);
		assert.equal(
			overlapEnd > overlapStart,
			true,
			`Expected overlap for same thread name across different sessions, got A=[${runA.start},${runA.end}] B=[${runB.start},${runB.end}]`,
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("PiActorRuntime should keep same-session serialization after canceling a queued invocation", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-runtime-queued-cancel-"));
	const markerFilePath = path.join(tmpDir, "markers.log");
	const delayMs = 500;

	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: (request) => ["-e", WINDOW_WORKER_SCRIPT, markerFilePath, request.runId, String(delayMs)],
	});

	try {
		const firstHandle = runtime.invoke({ runId: "same-A", thread: "same-thread", cwd: tmpDir, action: "noop" });
		await waitForRunStart(markerFilePath, "same-A");

		const queuedHandle = runtime.invoke({ runId: "same-B", thread: "same-thread", cwd: tmpDir, action: "noop" });
		void queuedHandle.cancel();
		const queuedResult = await queuedHandle.result;
		assert.equal(queuedResult.stopReason, "aborted");

		const laterHandle = runtime.invoke({ runId: "same-C", thread: "same-thread", cwd: tmpDir, action: "noop" });
		const [firstResult, laterResult] = await Promise.all([firstHandle.result, laterHandle.result]);

		assert.equal(firstResult.finalState.tag, "exited");
		assert.equal(laterResult.finalState.tag, "exited");

		const windows = parseWindows(markerFilePath);
		const firstRun = windows.get("same-A");
		const laterRun = windows.get("same-C");

		assert.equal(windows.has("same-B"), false, "the canceled queued invocation should never start a child worker");
		assert.equal(firstRun !== undefined, true);
		assert.equal(laterRun !== undefined, true);
		assert.equal(
			(laterRun as RunWindow).start >= (firstRun as RunWindow).end,
			true,
			`Expected queued-cancel serialization to keep same-C behind same-A, got same-A=[${(firstRun as RunWindow).start},${(firstRun as RunWindow).end}] same-C=[${(laterRun as RunWindow).start},${(laterRun as RunWindow).end}]`,
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
