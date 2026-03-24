import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { collectCompletedDispatchItems, rebuildEpisodeCounts } from "../../src/dispatch/history";

test("collectCompletedDispatchItems should canonicalize worker session paths and rebuild max episode counts", () => {
	const cwd = "/tmp/dispatch-history-projector";
	const canonicalSessionPath = path.join(cwd, ".pi", "threads", "alpha_beta.jsonl");

	const completedItems = collectCompletedDispatchItems(cwd, [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "dispatch",
				details: {
					mode: "batch",
					items: [
						{
							thread: "alpha/beta",
							action: "first alias task",
							episodeNumber: 1,
							result: {
								exitCode: 0,
								messages: [{ role: "assistant", content: [{ type: "text", text: "alpha one" }] }],
								usage: { cost: { total: 0.25 } },
							},
						},
						{
							thread: "alpha beta",
							action: "second alias task",
							episodeNumber: 2,
							result: {
								sessionPath: canonicalSessionPath,
								exitCode: 0,
								messages: [{ role: "assistant", content: [{ type: "text", text: "alpha two" }] }],
								usage: { cost: 0.5 },
							},
						},
					],
				},
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "read",
				details: {},
			},
		},
	]);

	assert.equal(completedItems.length, 2);
	assert.equal(completedItems[0]?.result.sessionPath, canonicalSessionPath);
	assert.equal(completedItems[0]?.result.usageCost, 0.25);
	assert.equal(completedItems[1]?.result.sessionPath, canonicalSessionPath);
	assert.equal(completedItems[1]?.result.usageCost, 0.5);

	const episodeCounts = new Map<string, number>();
	rebuildEpisodeCounts(episodeCounts, completedItems);

	assert.equal(episodeCounts.get(canonicalSessionPath), 2);
});
