import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { terminateProcess } from "../../src/runtime/termination";

test("terminateProcess force-kills a SIGTERM-ignoring child", async () => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			`
process.on("SIGTERM", () => {
  // Intentionally ignore SIGTERM.
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);

	const exitPromise = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
	const readyPromise = once(child.stdout as NodeJS.ReadableStream, "data");

	try {
		await readyPromise;
		const result = await terminateProcess(child, { sigtermGraceMs: 50 });
		const [exitCode, signal] = await exitPromise;

		assert.equal(exitCode, null);
		assert.equal(signal, "SIGKILL");
		assert.equal(result.forced, true);
		assert.equal(result.signal, "SIGKILL");
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exitPromise;
		}
	}
});

test("terminateProcess returns immediately for a child that already exited", async () => {
	const child = spawn(
		process.execPath,
		["-e", "process.exit(0)"],
		{ stdio: ["ignore", "ignore", "ignore"] },
	);

	const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
	const result = await terminateProcess(child, { sigtermGraceMs: 50 });

	assert.equal(exitCode, 0);
	assert.equal(signal, null);
	assert.equal(result.exitCode, 0);
	assert.equal(result.exitSignal, null);
	assert.equal(result.forced, false);
	assert.equal(result.signal, null);
});

test("terminateProcess respects a cooperative SIGTERM exit without escalating to SIGKILL", async () => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			`
process.on("SIGTERM", () => {
  process.exit(0);
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);

	const exitPromise = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
	const readyPromise = once(child.stdout as NodeJS.ReadableStream, "data");

	try {
		await readyPromise;
		const result = await terminateProcess(child, { sigtermGraceMs: 100 });
		const [exitCode, signal] = await exitPromise;

		assert.equal(exitCode, 0);
		assert.equal(signal, null);
		assert.equal(result.exitCode, 0);
		assert.equal(result.exitSignal, null);
		assert.equal(result.forced, false);
		assert.equal(result.signal, "SIGTERM");
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exitPromise;
		}
	}
});
