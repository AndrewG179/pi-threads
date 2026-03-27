import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	formatTokens,
	relativeTime,
	recordThreadName,
	removeThreadName,
	readThreadNameIndex,
	ensureThreadsDir,
	getThreadsDir,
	listThreadSessions,
	getThreadSessionPath,
} from "../helpers.ts";

// ─── Pure function tests ───

describe("formatTokens", () => {
	it("formats small numbers as-is", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats thousands with one decimal", () => {
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("formats ten-thousands as rounded k", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(50000)).toBe("50k");
		expect(formatTokens(999999)).toBe("1000k");
	});

	it("formats millions with one decimal", () => {
		expect(formatTokens(1000000)).toBe("1.0M");
		expect(formatTokens(1500000)).toBe("1.5M");
	});
});

describe("relativeTime", () => {
	it("returns 'just now' for recent times", () => {
		expect(relativeTime(Date.now() - 5000)).toBe("just now");
	});

	it("returns minutes ago", () => {
		expect(relativeTime(Date.now() - 300_000)).toBe("5m ago");
	});

	it("returns hours ago", () => {
		expect(relativeTime(Date.now() - 7_200_000)).toBe("2h ago");
	});

	it("returns days ago", () => {
		expect(relativeTime(Date.now() - 172_800_000)).toBe("2d ago");
	});
});

// ─── Thread name index tests (use temp dirs) ───

describe("thread name index", () => {
	let tmpDir: string;
	const sessionId = "test-session-123";

	beforeEach(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-threads-test-"));
	});

	afterEach(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	it("records and reads thread names", async () => {
		await recordThreadName(tmpDir, sessionId, "my-worker");
		const index = await readThreadNameIndex(tmpDir, sessionId);
		const values = Object.values(index);
		expect(values).toContain("my-worker");
	});

	it("removes thread names", async () => {
		await recordThreadName(tmpDir, sessionId, "to-delete");
		await removeThreadName(tmpDir, sessionId, "to-delete");
		const index = await readThreadNameIndex(tmpDir, sessionId);
		const values = Object.values(index);
		expect(values).not.toContain("to-delete");
	});

	it("handles concurrent writes without losing entries", async () => {
		// Dispatch 10 concurrent recordThreadName calls
		const promises = [];
		for (let i = 0; i < 10; i++) {
			promises.push(recordThreadName(tmpDir, sessionId, `thread-${i}`));
		}
		await Promise.all(promises);

		const index = await readThreadNameIndex(tmpDir, sessionId);
		const values = Object.values(index);
		for (let i = 0; i < 10; i++) {
			expect(values).toContain(`thread-${i}`);
		}
	});

	it("is idempotent for same thread name", async () => {
		await recordThreadName(tmpDir, sessionId, "worker");
		await recordThreadName(tmpDir, sessionId, "worker");
		const index = await readThreadNameIndex(tmpDir, sessionId);
		const count = Object.values(index).filter(v => v === "worker").length;
		expect(count).toBe(1);
	});

	it("returns empty index for missing sessionId", async () => {
		const index = await readThreadNameIndex(tmpDir, "");
		expect(index).toEqual({});
	});

	it("returns empty index for missing file", async () => {
		const index = await readThreadNameIndex(tmpDir, "nonexistent-session");
		expect(index).toEqual({});
	});
});

describe("listThreadSessions", () => {
	let tmpDir: string;
	const sessionId = "test-session-456";

	beforeEach(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-threads-test-"));
	});

	afterEach(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns empty for no threads", async () => {
		const sessions = await listThreadSessions(tmpDir, sessionId);
		expect(sessions).toEqual([]);
	});

	it("lists thread sessions with resolved names", async () => {
		// Create threads dir and a session file
		await ensureThreadsDir(tmpDir, sessionId);
		const sessionPath = getThreadSessionPath(tmpDir, sessionId, "my-thread");
		await fs.promises.writeFile(sessionPath, '{"type":"session"}\n');

		// Record name
		await recordThreadName(tmpDir, sessionId, "my-thread");

		const sessions = await listThreadSessions(tmpDir, sessionId);
		expect(sessions.length).toBe(1);
		expect(sessions[0].threadName).toBe("my-thread");
		expect(sessions[0].sessionPath).toBe(sessionPath);
	});

	it("returns empty for missing sessionId", async () => {
		const sessions = await listThreadSessions(tmpDir, "");
		expect(sessions).toEqual([]);
	});
});
