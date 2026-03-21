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
