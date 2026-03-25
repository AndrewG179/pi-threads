import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import type { Message } from "@mariozechner/pi-ai";

import { collectCompletedDispatchItems } from "../../src/dispatch/history";
import { SubagentRunStore } from "../../src/subagents/runtime-store";

function assistantText(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as Message;
}

function assistantWithTool(text: string, command: string): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", name: "bash", arguments: { command } },
		],
	} as Message;
}

function dispatchToolResult(items: unknown[]) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "dispatch",
			details: {
				mode: items.length > 1 ? "batch" : "single",
				items,
			},
		},
	};
}

test("SubagentRunStore isolates live cards by parent session even when thread names match", () => {
	const store = new SubagentRunStore();
	const parentA = "/tmp/runtime-store-parent-a/.pi/sessions/parent.jsonl";
	const parentB = "/tmp/runtime-store-parent-b/.pi/sessions/parent.jsonl";
	const threadSessionA = "/tmp/runtime-store-parent-a/.pi/threads/shared.jsonl";
	const threadSessionB = "/tmp/runtime-store-parent-b/.pi/threads/shared.jsonl";

	store.startRun({
		parentSessionFile: parentA,
		runId: "run-a",
		thread: "shared",
		sessionPath: threadSessionA,
		action: "Inspect alpha implementation",
	});
	store.recordMessage({
		parentSessionFile: parentA,
		runId: "run-a",
		sessionPath: threadSessionA,
		message: assistantText("alpha progress"),
		liveCost: 0.11,
	});

	store.startRun({
		parentSessionFile: parentB,
		runId: "run-b",
		thread: "shared",
		sessionPath: threadSessionB,
		action: "Inspect beta implementation",
	});
	store.recordMessage({
		parentSessionFile: parentB,
		runId: "run-b",
		sessionPath: threadSessionB,
		message: assistantText("beta progress"),
		liveCost: 0.22,
	});

	const cardA = store.getCards(parentA)[0];
	const cardB = store.getCards(parentB)[0];

	assert.equal(cardA.thread, "shared");
	assert.equal(cardA.sessionPath, path.resolve(threadSessionA));
	assert.equal(cardA.latestAction, "Inspect alpha implementation");
	assert.equal(cardA.outputPreview, "alpha progress");
	assert.equal(cardA.accumulatedCost, 0.11);

	assert.equal(cardB.thread, "shared");
	assert.equal(cardB.sessionPath, path.resolve(threadSessionB));
	assert.equal(cardB.latestAction, "Inspect beta implementation");
	assert.equal(cardB.outputPreview, "beta progress");
	assert.equal(cardB.accumulatedCost, 0.22);

	assert.deepEqual(store.getCards("/tmp/runtime-store-parent-c/.pi/sessions/parent.jsonl"), []);
});

test("SubagentRunStore ignores stale live updates once a newer run owns the thread record", () => {
	const store = new SubagentRunStore();
	const parentSession = "/tmp/runtime-store-stale/.pi/sessions/parent.jsonl";
	const threadSession = "/tmp/runtime-store-stale/.pi/threads/alpha.jsonl";

	store.startRun({
		parentSessionFile: parentSession,
		runId: "run-1",
		thread: "alpha",
		sessionPath: threadSession,
		action: "First attempt",
	});
	store.recordMessage({
		parentSessionFile: parentSession,
		runId: "run-1",
		sessionPath: threadSession,
		message: assistantText("first progress"),
		liveCost: 0.4,
	});

	store.startRun({
		parentSessionFile: parentSession,
		runId: "run-2",
		thread: "alpha",
		sessionPath: threadSession,
		action: "Second attempt",
	});
	store.recordMessage({
		parentSessionFile: parentSession,
		runId: "run-1",
		sessionPath: threadSession,
		message: assistantText("stale progress"),
		liveCost: 9.9,
	});
	store.finishRun({
		parentSessionFile: parentSession,
		runId: "run-1",
		thread: "alpha",
		sessionPath: threadSession,
		action: "First attempt",
		episodeNumber: 1,
		status: "done",
		usageCost: 1.5,
		messages: [assistantText("stale finish")],
	});

	store.recordMessage({
		parentSessionFile: parentSession,
		runId: "run-2",
		sessionPath: threadSession,
		message: assistantWithTool("fresh progress", "echo fresh"),
		liveCost: 0.25,
	});
	store.finishRun({
		parentSessionFile: parentSession,
		runId: "run-2",
		thread: "alpha",
		sessionPath: threadSession,
		action: "Second attempt",
		episodeNumber: 2,
		status: "done",
		usageCost: 0.75,
		messages: [assistantWithTool("fresh finish", "echo fresh")],
	});

	const card = store.getCards(parentSession)[0];

	assert.equal(card.latestAction, "Second attempt");
	assert.equal(card.outputPreview, "fresh finish");
	assert.deepEqual(card.outputTail, ["fresh finish"]);
	assert.equal(card.toolPreview, "$ echo fresh");
	assert.equal(card.accumulatedCost, 0.75);
	assert.equal(card.status, "done");
});

test("SubagentRunStore does not double-count finished cost when parent toolResults later seed the same completed run", () => {
	const store = new SubagentRunStore();
	const cwd = "/tmp/runtime-store-dedupe";
	const parentSession = path.join(cwd, ".pi", "sessions", "parent.jsonl");
	const threadSession = path.join(cwd, ".pi", "threads", "alpha.jsonl");

	store.startRun({
		parentSessionFile: parentSession,
		runId: "run-1",
		thread: "alpha",
		sessionPath: threadSession,
		action: "Inspect alpha",
	});
	store.finishRun({
		parentSessionFile: parentSession,
		runId: "run-1",
		thread: "alpha",
		sessionPath: threadSession,
		action: "Inspect alpha",
		episodeNumber: 1,
		status: "done",
		usageCost: 0.75,
		messages: [assistantText("alpha done")],
	});

	store.seedCompletedFromParent(parentSession, collectCompletedDispatchItems(cwd, [
		dispatchToolResult([
			{
				thread: "alpha",
				action: "Inspect alpha",
				episodeNumber: 1,
				result: {
					exitCode: 0,
					messages: [assistantText("alpha done")],
					usage: { cost: 0.75 },
				},
			},
		]),
	]));
	store.seedCompletedFromParent(parentSession, collectCompletedDispatchItems(cwd, [
		dispatchToolResult([
			{
				thread: "alpha",
				action: "Inspect alpha",
				episodeNumber: 1,
				result: {
					exitCode: 0,
					messages: [assistantText("alpha done")],
					usage: { cost: { total: 0.75 } },
				},
			},
		]),
	]));

	const card = store.getCards(parentSession)[0];

	assert.equal(card.sessionPath, path.resolve(threadSession));
	assert.equal(card.latestAction, "Inspect alpha");
	assert.equal(card.outputPreview, "alpha done");
	assert.equal(card.accumulatedCost, 0.75);
	assert.equal(card.status, "done");
});

test("SubagentRunStore reseeding completed parent history should not overwrite newer live action, output, or status", () => {
	const store = new SubagentRunStore();
	const cwd = "/tmp/runtime-store-reseed-live";
	const parentSession = path.join(cwd, ".pi", "sessions", "parent.jsonl");
	const threadSession = path.join(cwd, ".pi", "threads", "alpha.jsonl");

	store.seedCompletedFromParent(parentSession, collectCompletedDispatchItems(cwd, [
		dispatchToolResult([
			{
				thread: "alpha",
				action: "Historical alpha task",
				episodeNumber: 1,
				result: {
					exitCode: 0,
					messages: [assistantText("historical done")],
					usage: { cost: 0.5 },
				},
			},
		]),
	]));

	store.startRun({
		parentSessionFile: parentSession,
		runId: "run-2",
		thread: "alpha",
		sessionPath: threadSession,
		action: "Live alpha task",
	});
	store.recordMessage({
		parentSessionFile: parentSession,
		runId: "run-2",
		sessionPath: threadSession,
		message: assistantWithTool("live progress", "echo live"),
		liveCost: 0.2,
	});

	store.seedCompletedFromParent(parentSession, collectCompletedDispatchItems(cwd, [
		dispatchToolResult([
			{
				thread: "alpha",
				action: "Historical alpha task",
				episodeNumber: 1,
				result: {
					exitCode: 0,
					messages: [assistantText("historical done")],
					usage: { cost: 0.5 },
				},
			},
		]),
	]));

	const card = store.getCards(parentSession)[0];

	assert.equal(card.latestAction, "Live alpha task");
	assert.equal(card.outputPreview, "live progress");
	assert.deepEqual(card.outputTail, ["live progress"]);
	assert.equal(card.toolPreview, "$ echo live");
	assert.equal(card.status, "unknown");
	assert.equal(card.accumulatedCost, 0.7);
});

test("SubagentRunStore should reconcile normalized thread aliases onto one canonical session record", () => {
	const store = new SubagentRunStore();
	const cwd = "/tmp/runtime-store-alias";
	const parentSession = path.join(cwd, ".pi", "sessions", "parent.jsonl");
	const aliasSession = path.join(cwd, ".pi", "threads", "collision_a.jsonl");

	store.startRun({
		parentSessionFile: parentSession,
		runId: "run-1",
		thread: "collision/a",
		sessionPath: aliasSession,
		action: "First alias action",
	});
	store.recordMessage({
		parentSessionFile: parentSession,
		runId: "run-1",
		sessionPath: aliasSession,
		message: assistantText("first alias output"),
		liveCost: 0.25,
	});
	store.finishRun({
		parentSessionFile: parentSession,
		runId: "run-1",
		thread: "collision/a",
		sessionPath: aliasSession,
		action: "First alias action",
		episodeNumber: 1,
		status: "done",
		usageCost: 0.25,
		messages: [assistantText("first alias output")],
	});

	store.startRun({
		parentSessionFile: parentSession,
		runId: "run-2",
		thread: "collision_a",
		sessionPath: aliasSession,
		action: "Second alias action",
	});
	store.finishRun({
		parentSessionFile: parentSession,
		runId: "run-2",
		thread: "collision_a",
		sessionPath: aliasSession,
		action: "Second alias action",
		episodeNumber: 2,
		status: "done",
		usageCost: 0.5,
		messages: [assistantText("second alias output")],
	});

	const cards = store.getCards(parentSession);
	assert.equal(cards.length, 1, "one canonical worker session should produce one card even when thread aliases differ");
	assert.equal(cards[0]?.thread, "collision_a", "the latest raw alias should remain available as presentation metadata");
	assert.equal(cards[0]?.sessionPath, path.resolve(aliasSession));
	assert.equal(cards[0]?.latestAction, "Second alias action");
	assert.equal(cards[0]?.outputPreview, "second alias output");
	assert.equal(cards[0]?.accumulatedCost, 0.75);
});
