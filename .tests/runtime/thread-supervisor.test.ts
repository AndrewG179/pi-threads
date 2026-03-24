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

const CANCELLABLE_WORKER_SCRIPT = `
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "worker-started" }]
    }
  }) + "\\n");
}, 25);
setInterval(() => {}, 1000);
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
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

test("PiActorRuntime cancels queued same-session runs without starting a child", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-runtime-queued-cancel-"));
	const markerFilePath = path.join(tmpDir, "markers.log");
	const delayMs = 400;

	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: (request) => ["-e", WINDOW_WORKER_SCRIPT, markerFilePath, request.runId, String(delayMs)],
	});

	try {
		const runningHandle = runtime.invoke({
			runId: "queued-cancel-running",
			thread: "same-thread",
			cwd: tmpDir,
			action: "noop",
		});
		const queuedHandle = runtime.invoke({
			runId: "queued-cancel-target",
			thread: "same-thread",
			cwd: tmpDir,
			action: "noop",
		});

		await waitFor(() => runningHandle.getSnapshot().state.tag === "running");

		const cancelStart = Date.now();
		await queuedHandle.cancel("abort");
		const queuedResult = await queuedHandle.result;
		const cancelDurationMs = Date.now() - cancelStart;

		assert.equal(cancelDurationMs < delayMs, true, `queued cancel should not wait ${delayMs}ms for prior run`);
		assert.equal(queuedResult.stopReason, "aborted");
		assert.equal(queuedResult.finalState.tag, "exited");
		assert.equal(queuedResult.finalState.requestedTerminationReason, "abort");
		assert.equal(queuedResult.messages.length, 0);

		const runningResult = await runningHandle.result;
		assert.equal(runningResult.finalState.tag, "exited");

		const windows = parseWindows(markerFilePath);
		assert.equal(windows.has("queued-cancel-running"), true);
		assert.equal(windows.has("queued-cancel-target"), false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("PiActorRuntime aborts externally signalled queued runs without starting a child or disturbing the active same-session run", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-runtime-external-queued-abort-"));
	const markerFilePath = path.join(tmpDir, "markers.log");
	const delayMs = 180;

	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: (request) => ["-e", WINDOW_WORKER_SCRIPT, markerFilePath, request.runId, String(delayMs)],
	});

	try {
		const runningHandle = runtime.invoke({
			runId: "external-abort-running",
			thread: "same-thread",
			cwd: tmpDir,
			action: "noop",
		});
		const queuedAbortController = new AbortController();
		const queuedHandle = runtime.invoke(
			{
				runId: "external-abort-queued",
				thread: "same-thread",
				cwd: tmpDir,
				action: "noop",
			},
			{ signal: queuedAbortController.signal },
		);

		await waitFor(() => runningHandle.getSnapshot().state.tag === "running");
		queuedAbortController.abort();

		const queuedResult = await queuedHandle.result;
		assert.equal(queuedResult.stopReason, "aborted");
		assert.equal(queuedResult.finalState.tag, "exited");
		assert.equal(queuedResult.finalState.requestedTerminationReason, "abort");
		assert.equal(queuedResult.messages.length, 0);
		assert.equal(queuedHandle.getSnapshot().state.tag, "exited");

		const runningResult = await runningHandle.result;
		assert.equal(runningResult.finalState.tag, "exited");
		assert.equal(runningResult.messages[0]?.role, "assistant");

		const windows = parseWindows(markerFilePath);
		assert.equal(windows.has("external-abort-running"), true);
		assert.equal(windows.has("external-abort-queued"), false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("PiActorRuntime exposes handle events and snapshots across cancellation", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-runtime-cancel-"));

	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: () => ["-e", CANCELLABLE_WORKER_SCRIPT],
		defaultSigtermGraceMs: 50,
	});

	try {
		const handle = runtime.invoke({
			runId: "cancel-me",
			thread: "cancel-thread",
			cwd: tmpDir,
			action: "noop",
		});

		assert.equal(typeof handle.cancel, "function");
		assert.equal(typeof handle.subscribe, "function");

		const events: string[] = [];
		const unsubscribe = handle.subscribe((event) => {
			events.push(event.type);
		});

		await waitFor(() => events.includes("message"));
		await waitFor(() => handle.getSnapshot().state.tag === "running");

		await handle.cancel("abort");
		const result = await handle.result;
		unsubscribe();

		assert.equal(result.stopReason, "aborted");
		assert.equal(result.finalState.tag, "exited");
		assert.equal(result.finalState.requestedTerminationReason, "abort");
		assert.equal(handle.getSnapshot().state.tag, "exited");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
