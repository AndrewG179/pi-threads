import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { terminateActorProcess } from "../../src/actors/termination";

test("terminateActorProcess force-kills a SIGTERM-ignoring child", async () => {
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
		const result = await terminateActorProcess(child, { sigtermGraceMs: 50 });
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
