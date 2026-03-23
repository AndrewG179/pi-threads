import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { collectSubagentCards } from "../../src/subagents/metadata";

function writeThreadSession(filePath: string, lines: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
		"utf8",
	);
}

test("collectSubagentCards combines thread transcript previews with current-parent dispatch metadata", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-cards-"));
	const alphaSession = path.join(cwd, ".pi", "threads", "alpha.jsonl");

	try {
		writeThreadSession(alphaSession, [
			{ type: "session", version: 3, cwd },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Respond with exactly: hello" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hello" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
				},
			},
		]);
		const cards = collectSubagentCards(cwd, [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "dispatch",
					details: {
						mode: "single",
						items: [{
							thread: "alpha",
							action: "Respond with exactly: hello",
							episode: "hello",
							episodeNumber: 1,
							result: {
								thread: "alpha",
								action: "Respond with exactly: hello",
								exitCode: 0,
								stderr: "",
								messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
								usage: {
									input: 10,
									output: 2,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0.25,
									contextTokens: 12,
									turns: 1,
								},
								sessionPath: alphaSession,
								isNewThread: true,
							},
						}],
					},
				},
			},
		]);

		assert.equal(cards.length, 1);
		assert.deepEqual(cards[0], {
			thread: "alpha",
			sessionPath: alphaSession,
			latestAction: "Respond with exactly: hello",
			outputPreview: "hello",
			toolPreview: "$ echo hello",
			accumulatedCost: 0.25,
			status: "done",
			parentSessionFile: undefined,
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("collectSubagentCards ignores dispatch metadata for threads without real session files", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-phantom-"));

	try {
		const cards = collectSubagentCards(cwd, [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "dispatch",
					details: {
						mode: "single",
						items: [{
							thread: "ghost",
							action: "Respond with exactly: hello",
							episode: "(running...)",
							episodeNumber: 1,
							result: {
								thread: "ghost",
								action: "Respond with exactly: hello",
								exitCode: 0,
								stderr: "",
								messages: [],
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0,
									contextTokens: 0,
									turns: 0,
								},
								sessionPath: path.join(cwd, ".pi", "threads", "ghost.jsonl"),
								isNewThread: true,
							},
						}],
					},
				},
			},
		]);

		assert.equal(cards.length, 0);
		assert.equal(cards.some((card) => card.thread === "ghost"), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("collectSubagentCards only includes threads from the current parent branch even without thread state", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-current-parent-"));
	const alphaSession = path.join(cwd, ".pi", "threads", "alpha.jsonl");
	const betaSession = path.join(cwd, ".pi", "threads", "beta.jsonl");

	try {
		writeThreadSession(alphaSession, [
			{ type: "session", version: 3, cwd },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Respond with exactly: hello" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
				},
			},
		]);
		writeThreadSession(betaSession, [
			{ type: "session", version: 3, cwd },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Investigate the auth hang" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "old thread" }],
				},
			},
		]);

		const cards = collectSubagentCards(cwd, [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "dispatch",
					details: {
						mode: "single",
						items: [{
							thread: "alpha",
							action: "Respond with exactly: hello",
							episode: "hello",
							episodeNumber: 1,
							result: {
								exitCode: 0,
								stderr: "",
								messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
								usage: {
									input: 10,
									output: 2,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0.25,
									contextTokens: 12,
									turns: 1,
								},
								sessionPath: alphaSession,
								isNewThread: true,
							},
						}],
					},
				},
			},
		]);

		assert.equal(cards.length, 1);
		assert.deepEqual(cards[0], {
			thread: "alpha",
			sessionPath: alphaSession,
			latestAction: "Respond with exactly: hello",
			outputPreview: "hello",
			toolPreview: "",
			accumulatedCost: 0.25,
			status: "done",
			parentSessionFile: undefined,
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
