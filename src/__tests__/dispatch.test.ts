import { describe, it, expect } from "vitest";
import { isRetryableFailure, buildEpisode } from "../dispatch.ts";
import type { ThreadActionResult } from "../types.ts";

function makeResult(overrides: Partial<ThreadActionResult> = {}): ThreadActionResult {
	return {
		thread: "test",
		action: "test action",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		sessionPath: "/tmp/test.jsonl",
		isNewThread: false,
		...overrides,
	};
}

describe("isRetryableFailure", () => {
	it("returns false for successful results", () => {
		const result = makeResult({ exitCode: 0 });
		expect(isRetryableFailure(result)).toBe(false);
	});

	it("returns false when signal is aborted", () => {
		const result = makeResult({ exitCode: 1, stderr: "ECONNREFUSED" });
		const controller = new AbortController();
		controller.abort();
		expect(isRetryableFailure(result, controller.signal)).toBe(false);
	});

	it("returns true for ECONNREFUSED", () => {
		const result = makeResult({ exitCode: 1, stderr: "Error: connect ECONNREFUSED 127.0.0.1:3000" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns true for ECONNRESET", () => {
		const result = makeResult({ exitCode: 1, stderr: "ECONNRESET" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns true for ETIMEDOUT", () => {
		const result = makeResult({ exitCode: 1, stderr: "ETIMEDOUT" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns true for rate limit / 429", () => {
		const result = makeResult({ exitCode: 1, stderr: "429 Too Many Requests" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns true for 503 errors", () => {
		const result = makeResult({ exitCode: 1, stderr: "503 Service Unavailable" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns true for socket hang up", () => {
		const result = makeResult({ exitCode: 1, stderr: "socket hang up" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns true for network error", () => {
		const result = makeResult({ exitCode: 1, stderr: "network error occurred" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns true for network timeout", () => {
		const result = makeResult({ exitCode: 1, stderr: "network timeout" });
		expect(isRetryableFailure(result)).toBe(true);
	});

	it("returns false for generic 'network' without qualifier", () => {
		const result = makeResult({ exitCode: 1, stderr: "network configuration is invalid" });
		expect(isRetryableFailure(result)).toBe(false);
	});

	it("returns false for deterministic failures", () => {
		const result = makeResult({ exitCode: 1, stderr: "Permission denied" });
		expect(isRetryableFailure(result)).toBe(false);
	});

	it("returns false for empty stderr with non-zero exit", () => {
		const result = makeResult({ exitCode: 1, stderr: "", messages: [] });
		expect(isRetryableFailure(result)).toBe(false);
	});

	it("returns false for failures with messages (thread ran but failed)", () => {
		const result = makeResult({
			exitCode: 1,
			stderr: "something went wrong",
			messages: [{ role: "assistant", content: [{ type: "text", text: "I tried" }] } as any],
		});
		expect(isRetryableFailure(result)).toBe(false);
	});

	it("checks errorMessage field too", () => {
		const result = makeResult({ exitCode: 1, stderr: "", errorMessage: "ECONNREFUSED" });
		expect(isRetryableFailure(result)).toBe(true);
	});
});

describe("buildEpisode", () => {
	it("returns (no output) for empty messages", () => {
		expect(buildEpisode([])).toBe("(no output)");
	});

	it("includes tool call history", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
					{ type: "text", text: "Done listing files" },
				],
			},
		] as any;
		const episode = buildEpisode(messages);
		expect(episode).toContain("TOOL CALLS:");
		expect(episode).toContain("$ ls -la");
		expect(episode).toContain("THREAD RESPONSE:");
		expect(episode).toContain("Done listing files");
	});

	it("includes compaction notice", () => {
		const episode = buildEpisode([], { tokensBefore: 50000, tokensAfter: 10000 });
		expect(episode).toContain("compacted");
		expect(episode).toContain("50k");
		expect(episode).toContain("10k");
	});

	it("includes error context", () => {
		const episode = buildEpisode([], undefined, "spawn ENOENT", 1, "Process failed");
		expect(episode).toContain("ERROR (exit 1)");
		expect(episode).toContain("spawn ENOENT");
		expect(episode).toContain("ERROR: Process failed");
	});

	it("includes retry context", () => {
		const episode = buildEpisode([], undefined, undefined, undefined, undefined, "First attempt: ECONNREFUSED");
		expect(episode).toContain("RETRY CONTEXT:");
		expect(episode).toContain("First attempt: ECONNREFUSED");
	});

	it("formats read tool calls", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall", name: "read", arguments: { file_path: "/src/index.ts", offset: 10, limit: 20 } },
				],
			},
		] as any;
		const episode = buildEpisode(messages);
		expect(episode).toContain("read /src/index.ts:10-29");
	});

	it("formats write tool calls with line count", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall", name: "write", arguments: { file_path: "/src/out.ts", content: "line1\nline2\nline3" } },
				],
			},
		] as any;
		const episode = buildEpisode(messages);
		expect(episode).toContain("write /src/out.ts (3 lines)");
	});
});
