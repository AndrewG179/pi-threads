/**
 * Standalone tests for the three bug fixes.
 * Run with: node test-fixes.mjs
 */
import * as path from "node:path";
import * as fs from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition, message) {
	if (condition) {
		console.log(`  ✅ ${message}`);
		passed++;
	} else {
		console.log(`  ❌ ${message}`);
		failed++;
	}
}

// ═══════════════════════════════════════════════════════════════════
// Test 1: Path traversal defense in getThreadsDir and getThreadSessionPath
// ═══════════════════════════════════════════════════════════════════
console.log("\n🔒 Test 1: Path traversal defense");

const THREADS_DIR = ".pi/threads";

function getThreadsDir(cwd, sessionId) {
	if (!sessionId) throw new Error("sessionId is required for thread directory resolution");
	const safe = sessionId.replace(/[^\w.-]+/g, "_");
	if (safe === "." || safe === "..") throw new Error(`Invalid sessionId: "${sessionId}"`);
	return path.join(cwd, THREADS_DIR, safe);
}

function getThreadSessionPath(cwd, sessionId, threadName) {
	const safe = threadName.replace(/[^\w.-]+/g, "_");
	if (safe === "." || safe === "..") throw new Error(`Invalid thread name: "${threadName}"`);
	return path.join(getThreadsDir(cwd, sessionId), `${safe}.jsonl`);
}

// Normal names should work
const normalResult = getThreadSessionPath("/tmp", "abc123", "my-thread");
assert(normalResult === "/tmp/.pi/threads/abc123/my-thread.jsonl", `Normal name: ${normalResult}`);

const dotInName = getThreadSessionPath("/tmp", "abc123", "my.thread");
assert(dotInName === "/tmp/.pi/threads/abc123/my.thread.jsonl", `Dot in name: ${dotInName}`);

// sessionId with dot should throw
let threwForSessionDot = false;
try { getThreadsDir("/tmp", "."); } catch (e) {
	threwForSessionDot = true;
	assert(e.message.includes("Invalid sessionId"), `SessionId dot error: ${e.message}`);
}
assert(threwForSessionDot, "SessionId '.' throws");

let threwForSessionDotDot = false;
try { getThreadsDir("/tmp", ".."); } catch (e) {
	threwForSessionDotDot = true;
	assert(e.message.includes("Invalid sessionId"), `SessionId '..' error: ${e.message}`);
}
assert(threwForSessionDotDot, "SessionId '..' throws");

// Empty sessionId should throw
let threwForEmpty = false;
try { getThreadsDir("/tmp", ""); } catch (e) {
	threwForEmpty = true;
}
assert(threwForEmpty, "Empty sessionId throws");

// threadName dot/dotdot should throw
let threwForThreadDot = false;
try { getThreadSessionPath("/tmp", "abc123", "."); } catch (e) {
	threwForThreadDot = true;
	assert(e.message.includes("Invalid thread name"), `Thread dot error: ${e.message}`);
}
assert(threwForThreadDot, "Thread name '.' throws");

let threwForThreadDotDot = false;
try { getThreadSessionPath("/tmp", "abc123", ".."); } catch (e) {
	threwForThreadDotDot = true;
	assert(e.message.includes("Invalid thread name"), `Thread '..' error: ${e.message}`);
}
assert(threwForThreadDotDot, "Thread name '..' throws");

// Path with slashes gets sanitized
const slashResult = getThreadSessionPath("/tmp", "abc123", "../../../etc/passwd");
assert(
	slashResult === "/tmp/.pi/threads/abc123/.._.._.._etc_passwd.jsonl",
	`Slash sanitized: ${slashResult}`
);

// Verify the result stays under threads dir
const resolvedSlash = path.resolve(slashResult);
const threadsDir = path.resolve("/tmp/.pi/threads/abc123");
assert(resolvedSlash.startsWith(threadsDir), `Stays under threads dir: ${resolvedSlash}`);

// ═══════════════════════════════════════════════════════════════════
// Test 2: lastCompactedAt reconstruction uses entry timestamp
// ═══════════════════════════════════════════════════════════════════
console.log("\n⏰ Test 2: lastCompactedAt reconstruction logic");

function reconstructThreadStats(branchEntries) {
	const episodeCounts = new Map();
	const threadStats = new Map();
	
	for (const entry of branchEntries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			if (entry.message.toolName === "dispatch") {
				const details = entry.message.details;
				if (details?.items) {
					for (const item of details.items) {
						episodeCounts.set(item.thread, Math.max(episodeCounts.get(item.thread) || 0, item.episodeNumber));
						if (item.result?.usage) {
							const existing = threadStats.get(item.thread);
							threadStats.set(item.thread, {
								contextTokens: item.result.usage.contextTokens || 0,
								lastCompactedAt: item.result.compaction ? (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()) : (existing?.lastCompactedAt || 0),
								compactionCount: (existing?.compactionCount || 0) + (item.result.compaction ? 1 : 0),
							});
						}
					}
				}
			}
		}
	}
	
	return { episodeCounts, threadStats };
}

const originalTimestamp = new Date("2023-11-14T22:13:20.000Z").getTime();
const originalTimestampStr = "2023-11-14T22:13:20.000Z";

const mockEntries = [
	{
		type: "message",
		timestamp: originalTimestampStr,
		message: {
			role: "toolResult",
			toolName: "dispatch",
			details: {
				items: [{
					thread: "worker-a",
					episodeNumber: 1,
					result: {
						usage: { contextTokens: 5000 },
						compaction: { tokensBefore: 10000, tokensAfter: 5000 },
					},
				}],
			},
		},
	},
	{
		type: "message",
		timestamp: new Date(originalTimestamp + 60000).toISOString(),
		message: {
			role: "toolResult",
			toolName: "dispatch",
			details: {
				items: [{
					thread: "worker-a",
					episodeNumber: 2,
					result: {
						usage: { contextTokens: 8000 },
					},
				}],
			},
		},
	},
	{
		type: "message",
		timestamp: new Date(originalTimestamp + 120000).toISOString(),
		message: {
			role: "toolResult",
			toolName: "dispatch",
			details: {
				items: [{
					thread: "worker-b",
					episodeNumber: 1,
					result: {
						usage: { contextTokens: 3000 },
					},
				}],
			},
		},
	},
];

const result = reconstructThreadStats(mockEntries);

assert(result.episodeCounts.get("worker-a") === 2, "worker-a episode count = 2");
assert(result.episodeCounts.get("worker-b") === 1, "worker-b episode count = 1");

const statsA = result.threadStats.get("worker-a");
assert(statsA.contextTokens === 8000, `worker-a contextTokens = ${statsA.contextTokens} (latest)`);
assert(statsA.lastCompactedAt === originalTimestamp, `worker-a lastCompactedAt = ${statsA.lastCompactedAt} (original timestamp, not Date.now())`);
assert(statsA.compactionCount === 1, `worker-a compactionCount = ${statsA.compactionCount}`);

const statsB = result.threadStats.get("worker-b");
assert(statsB.contextTokens === 3000, `worker-b contextTokens = ${statsB.contextTokens}`);
assert(statsB.lastCompactedAt === 0, `worker-b lastCompactedAt = 0 (no compaction)`);
assert(statsB.compactionCount === 0, `worker-b compactionCount = 0`);

assert(
	Math.abs(statsA.lastCompactedAt - Date.now()) > 1000000,
	"lastCompactedAt is the original timestamp, not current time"
);

// ═══════════════════════════════════════════════════════════════════
// Test 3: Verify session_fork handler exists in source
// ═══════════════════════════════════════════════════════════════════
console.log("\n🔀 Test 3: session_fork handler presence");

const indexSource = fs.readFileSync(
	path.join(path.dirname(new URL(import.meta.url).pathname), "index.ts"),
	"utf-8"
);

assert(indexSource.includes('pi.on("session_fork"'), "session_fork handler registered");
assert(indexSource.includes('pi.on("session_start"'), "session_start handler still present");
assert(indexSource.includes('pi.on("session_switch"'), "session_switch handler still present");

// Verify session_fork calls initSessionState (shared logic)
const forkMatch = indexSource.match(/pi\.on\("session_fork"[\s\S]*?\}\);/);
assert(forkMatch !== null, "session_fork handler block found");
if (forkMatch) {
	assert(forkMatch[0].includes("initSessionState"), "session_fork uses shared initSessionState");
}

// Verify lastCompactedAt uses entry.timestamp in initSessionState
const initMatch = indexSource.match(/async function initSessionState[\s\S]*?^\t\}/m);
assert(initMatch !== null, "initSessionState function found");
if (initMatch) {
	assert(initMatch[0].includes("new Date(entry.timestamp).getTime()"), "initSessionState uses entry.timestamp for lastCompactedAt");
	assert(!initMatch[0].match(/lastCompactedAt:.*\bDate\.now\(\)\s*:/), "initSessionState does NOT use bare Date.now() for compacted entries");
}

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
} else {
	console.log("All tests passed! ✅");
}
