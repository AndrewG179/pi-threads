import assert from "node:assert/strict";
import test from "node:test";

import { buildEpisode } from "../../src/episode/builder";

test("buildEpisode preserves multipart assistant text and tool-result summaries", () => {
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
		},
		{
			role: "toolResult",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "stdout: 12 passed\nstderr:" }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Part 1: tests were executed." },
				{ type: "text", text: "Part 2: all suites passed without retries." },
			],
		},
	] as const;

	const episode = buildEpisode(messages as Parameters<typeof buildEpisode>[0]);

	assert.match(episode, /Part 1: tests were executed\./);
	assert.match(episode, /Part 2: all suites passed without retries\./);
	assert.match(episode, /bash/i);
	assert.match(episode, /12 passed/i);
});
