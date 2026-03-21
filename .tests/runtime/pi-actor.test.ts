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

test("dispatch should not depend on pi being on PATH when the parent CLI path is explicit", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-cli-path-"));
	const originalPath = process.env.PATH;
	const originalArgv = [...process.argv];
	const fakePiPath = path.join(tmpDir, "fake-pi.js");

	try {
		fs.writeFileSync(
			fakePiPath,
			[
				"#!/usr/bin/env node",
				"process.stdout.write(JSON.stringify({",
				'  type: "message_end",',
				"  message: {",
				'    role: "assistant",',
				'    content: [{ type: "text", text: "hello" }],',
				"  },",
				"}) + \"\\n\");",
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);

		process.env.PATH = "";
		process.argv[1] = fakePiPath;

		const runtime = new PiActorRuntime();
		const handle = runtime.invoke({
			runId: "explicit-cli-path",
			thread: "smoke-fast",
			cwd: tmpDir,
			action: "Respond with exactly: hello",
		});

		const result = await handle.result;

		assert.equal(result.stopReason, undefined);
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.messages.length, 1);
		assert.equal(result.messages[0]?.role, "assistant");
		assert.equal(result.messages[0]?.content[0]?.type, "text");
		assert.equal(result.messages[0]?.content[0]?.text, "hello");
	} finally {
		process.env.PATH = originalPath;
		process.argv.splice(0, process.argv.length, ...originalArgv);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("dispatch should split canonical provider/model references into CLI provider and model args", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-model-args-"));
	const originalArgv = [...process.argv];
	const fakePiPath = path.join(tmpDir, "fake-pi.js");
	const argsOutPath = path.join(tmpDir, "args.json");

	try {
		fs.writeFileSync(
			fakePiPath,
			[
				"#!/usr/bin/env node",
				`require("node:fs").writeFileSync(${JSON.stringify(argsOutPath)}, JSON.stringify(process.argv.slice(2)));`,
				[
					"process.stdout.write(JSON.stringify({",
					'  type: "message_end",',
					"  message: {",
					'    role: "assistant",',
					'    model: "google/gemini-2.5-flash",',
					'    content: [{ type: "text", text: "hello" }],',
					"  },",
					"}) + \"\\n\");",
				].join("\n"),
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);

		process.argv[1] = fakePiPath;

		const runtime = new PiActorRuntime();
		const handle = runtime.invoke({
			runId: "split-model-args",
			thread: "smoke-fast",
			cwd: tmpDir,
			action: "Respond with exactly: hello",
			model: "google/gemini-2.5-flash",
		});

		await handle.result;

		const args = JSON.parse(fs.readFileSync(argsOutPath, "utf8")) as string[];
		const providerIndex = args.indexOf("--provider");
		const modelIndex = args.indexOf("--model");

		assert.notEqual(providerIndex, -1, "Expected worker args to include --provider");
		assert.equal(args[providerIndex + 1], "google");
		assert.notEqual(modelIndex, -1, "Expected worker args to include --model");
		assert.equal(args[modelIndex + 1], "gemini-2.5-flash");
		assert.equal(args.includes("google/gemini-2.5-flash"), false);
	} finally {
		process.argv.splice(0, process.argv.length, ...originalArgv);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
