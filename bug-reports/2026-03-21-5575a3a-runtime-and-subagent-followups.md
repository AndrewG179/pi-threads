# Runtime And Subagent Follow-ups

Date: 2026-03-21
Git version: `5575a3a` (`fix: persist subagent parent navigation`)

## BR-011: Worker dispatch still depends on `pi` being on `PATH`

### Expected

If the parent pi process is running successfully, dispatched worker threads should be able to launch the same pi CLI even when the binary was reached via an explicit path or wrapper rather than a `pi` entry on `PATH`.

### Actual

The worker runtime still defaults to spawning the literal `pi` command in [src/runtime/pi-actor.ts](../src/runtime/pi-actor.ts#L18). In a real throwaway session launched via `/tmp/pi-cli-live-KG0fTk/node_modules/.bin/pi`, the parent session worked, but dispatched thread execution failed with `spawn pi ENOENT`.

### Repro

1. Launch pi via an explicit binary path that is not available as `pi` on `PATH`.
2. Load this extension and enable thread mode.
3. Run `dispatch [smoke-live] Respond with exactly: hello`.
4. Observe that the parent tool call succeeds only far enough to try spawning the worker, then the worker result reports `spawn pi ENOENT`.

### Notes

This is a real runtime bug, not just a test harness issue. It breaks dispatch in environments where pi is installed but not exposed as a global `pi` executable.

## BR-012: `/subagents` can show phantom thread sessions that do not exist

### Expected

`/subagents` is documented to list known thread sessions from `.pi/threads/*.jsonl`. If a thread never produced a real session file, it should not appear as an openable card.

### Actual

The metadata layer merges parent dispatch results into cards even when there is no corresponding `.jsonl` file, then synthesizes a fake `sessionPath` in [src/subagents/metadata.ts](../src/subagents/metadata.ts#L257) and [src/subagents/metadata.ts](../src/subagents/metadata.ts#L260).

In the live repro above, `.pi/threads/state.json` existed with a remembered parent, but `.pi/threads/smoke-live.jsonl` did not exist. The current metadata logic would still fabricate a `/subagents` card for that thread.

### Repro

1. Trigger a dispatch attempt that records parent linkage but fails before creating a thread transcript file.
2. Run `/subagents`.
3. Observe that the failed thread can still appear as a selectable subagent, even though opening that path would create a fresh empty session rather than resume a real thread.

### Notes

This is both a UX bug and a correctness issue: it turns failed or never-started worker runs into navigable ghost sessions.

## BR-013: `Ctrl+B` back-navigation is not restart-safe

### Expected

After reopening directly into a remembered subagent session, `Ctrl+B` should still provide the documented back-navigation path to the remembered parent session.

### Actual

The current implementation caches a command-context `switchSession()` function in memory at [index.ts](../index.ts#L440) and [index.ts](../index.ts#L516), then falls back to that cache in [index.ts](../index.ts#L538). After a fresh restart directly into a subagent session, that cache is empty, so `Ctrl+B` only warns and cannot return to the parent.

### Repro

1. Create a remembered parent mapping for a real thread session.
2. Start a fresh pi runtime directly in the thread session, without first running `/threads`, `/subagents`, or `/subagents-back` in that runtime.
3. Press `Ctrl+B`.
4. Observe that there is no working back-navigation path because the in-memory switcher cache was never populated.

### Notes

This is narrower than the earlier shortcut crash bug. The current code is safe from throwing, but it still does not satisfy the documented behavior after restart.
