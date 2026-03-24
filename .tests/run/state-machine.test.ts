import assert from "node:assert/strict";
import test from "node:test";

import { transitionRunState, type RunState } from "../../src/run/state-machine";

test("transitionRunState supports explicit forward transitions", () => {
	const queued: Extract<RunState, { tag: "queued" }> = { tag: "queued" };

	const running = transitionRunState(queued, { type: "started", pid: 4242 });
	assert.equal(running.tag, "running");

	const terminating = transitionRunState(running, { type: "terminationRequested", reason: "abort" });
	assert.equal(terminating.tag, "terminating");

	const exited = transitionRunState(terminating, { type: "exited", exitCode: null, signal: "SIGKILL" });
	assert.equal(exited.tag, "exited");
});

test("transitionRunState is typed: invalid transitions do not compile", () => {
	const queued: Extract<RunState, { tag: "queued" }> = { tag: "queued" };
	const running = transitionRunState(queued, { type: "started", pid: 1 });
	const terminating = transitionRunState(running, { type: "terminationRequested", reason: "abort" });
	const exited = transitionRunState(terminating, { type: "exited", exitCode: 0, signal: null });

	// @ts-expect-error queued cannot jump directly to exited
	transitionRunState(queued, { type: "exited", exitCode: 0, signal: null });

	// @ts-expect-error exited cannot transition back to running
	transitionRunState(exited, { type: "started", pid: 2 });

	assert.equal(exited.tag, "exited");
});

test("transitionRunState preserves runtime metadata on exits and ignores unrelated runtime events", () => {
	const queued: RunState = { tag: "queued" };

	const queuedAfterTerminationRequest = transitionRunState(
		queued as Extract<RunState, { tag: "queued" }>,
		{ type: "terminationRequested", reason: "abort" } as any,
	);
	assert.deepEqual(queuedAfterTerminationRequest, queued);

	const running = transitionRunState({ tag: "queued" }, { type: "started", pid: 4242 });
	const runningAfterDuplicateStart = transitionRunState(
		running as Extract<RunState, { tag: "running" }>,
		{ type: "started", pid: 7 } as any,
	);
	assert.deepEqual(runningAfterDuplicateStart, running);

	const exitedFromRunning = transitionRunState(running, { type: "exited", exitCode: 1, signal: "SIGTERM" });
	assert.deepEqual(exitedFromRunning, {
		tag: "exited",
		pid: 4242,
		exitCode: 1,
		signal: "SIGTERM",
	});

	const terminating = transitionRunState(running, { type: "terminationRequested", reason: "shutdown" });
	const terminatingAfterDuplicateRequest = transitionRunState(
		terminating as Extract<RunState, { tag: "terminating" }>,
		{ type: "terminationRequested", reason: "abort" } as any,
	);
	assert.deepEqual(terminatingAfterDuplicateRequest, terminating);

	const exitedFromTerminating = transitionRunState(terminating, { type: "exited", exitCode: null, signal: "SIGKILL" });
	assert.deepEqual(exitedFromTerminating, {
		tag: "exited",
		pid: 4242,
		exitCode: null,
		signal: "SIGKILL",
		requestedTerminationReason: "shutdown",
	});
});
