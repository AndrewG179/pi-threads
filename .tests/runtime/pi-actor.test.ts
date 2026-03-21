import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PiActorRuntime } from "../../src/runtime/pi-actor.ts";

const EOF_SENSITIVE_WORKER_SCRIPT = `
const fs = require("node:fs");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }]
  }
}) + "\\n");

const buffer = Buffer.alloc(1);
try {
  while (fs.readSync(0, buffer, 0, 1, null) !== 0) {}
} catch {
  // Ignore stdin read errors and exit.
}
process.exit(0);
`;

type SettledResult =
	| { type: "result"; result: Awaited<ReturnType<PiActorRuntime["invoke"]>["result"]> }
	| { type: "timeout" };

test("PiActorRuntime closes worker stdin for one-shot invocations", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-eof-"));
	const workerPath = path.join(tmpDir, "eof-worker.js");
	fs.writeFileSync(workerPath, EOF_SENSITIVE_WORKER_SCRIPT, "utf8");

	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: () => [workerPath],
		defaultSigtermGraceMs: 25,
	});

	const handle = runtime.invoke({
		runId: "stdin-eof-repro",
		thread: "stdin-eof-thread",
		cwd: tmpDir,
		action: "noop",
	});

	try {
		const settled = await Promise.race<SettledResult>([
			handle.result.then((result) => ({ type: "result", result })),
			new Promise<SettledResult>((resolve) => setTimeout(() => resolve({ type: "timeout" }), 300)),
		]);

		assert.notEqual(
			settled.type,
			"timeout",
			"Expected PiActorRuntime to settle after the worker emitted its response",
		);
		if (settled.type === "result") {
			assert.equal(settled.result.finalState.tag, "exited");
			assert.equal(settled.result.messages.length > 0, true);
			assert.equal(settled.result.messages[0]?.role, "assistant");
		}
	} finally {
		await handle.cancel("abort").catch(() => {});
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
