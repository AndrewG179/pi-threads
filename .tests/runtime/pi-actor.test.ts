import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PiActorRuntime } from "../../src/runtime/pi-actor";

const EOF_SENSITIVE_WORKER_SCRIPT = `
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }]
  }
}) + "\\n");

process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  process.exit(0);
});
`;

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

test("PiActorRuntime settles after a one-shot child exits on stdin EOF", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-repro-"));
	const runtime = new PiActorRuntime({
		command: process.execPath,
		buildArgs: (request) => ["-e", EOF_SENSITIVE_WORKER_SCRIPT, request.action],
	});

	const handle = runtime.invoke({
		runId: "pi-actor-repro",
		thread: "pi-actor-repro",
		cwd,
		action: "noop",
	});

	const messages: string[] = [];
	const unsubscribe = handle.subscribe((event) => {
		if (event.type === "message" && event.message.role === "assistant") {
			messages.push("assistant");
		}
	});

	try {
		await settleWithin(
			new Promise<void>((resolve, reject) => {
				const startedAt = Date.now();
				const tick = setInterval(() => {
					if (messages.length > 0) {
						clearInterval(tick);
						resolve();
						return;
					}
					if (Date.now() - startedAt > 1_000) {
						clearInterval(tick);
						reject(new Error("assistant message was not observed"));
					}
				}, 10);
			}),
			1_500,
			"assistant message",
		);

		const result = await settleWithin(handle.result, 300, "PiActorRuntime result");
		assert.equal(result.messages.length > 0, true);
		assert.equal(result.finalState.tag, "exited");
	} finally {
		unsubscribe();
		await handle.cancel("abort").catch(() => undefined);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
