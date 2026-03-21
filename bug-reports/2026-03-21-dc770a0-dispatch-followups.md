# Dispatch Follow-ups

Date: 2026-03-21
Git version: `dc770a0` (`fix: inherit worker command and skip phantom subagents`)

## BR-014: Session tool restoration still uses a stale startup snapshot

### Expected

Leaving orchestrator mode should restore the session's current interactive tool set, including tools that were activated after extension startup.

### Actual

`index.ts` caches `defaultActiveTools` once at startup in [index.ts](../index.ts#L440) and reuses that same snapshot for every later mode sync in [index.ts](../index.ts#L495). The restore logic in [src/subagents/mode.ts](../src/subagents/mode.ts#L70) only sees the cached list, so any later tool-set changes are discarded when the session returns to normal mode.

### Repro

1. Start a normal session and let the extension cache the initial active tools.
2. Enter orchestrator mode.
3. Change the live active tools after startup so the current session now has a different interactive tool set.
4. Leave orchestrator mode.
5. Observe that the extension restores the startup snapshot rather than the current tool set.

### Notes

This is a real state-management bug in the session lifecycle, not just a `resolveActiveToolsForBehavior()` unit concern. The repro belongs at the `index.ts` integration layer where `session_start`, `/threads`, and `setActiveTools()` interact.

## BR-015: Hard worker failures still collapse to `(no output)` in dispatch summaries

### Expected

If a child worker exits before producing assistant output, the dispatch summary should still include the real failure reason instead of only `(no output)`.

### Actual

`PiActorRuntime` records `stderr` and `errorMessage` for child failures in [src/runtime/pi-actor.ts](../src/runtime/pi-actor.ts#L464), but `dispatch` still builds the returned episode solely from `result.messages` in [index.ts](../index.ts#L807). Since [src/episode/builder.ts](../src/episode/builder.ts#L82) returns `(no output)` when there are no assistant messages, hard failures still produce summaries like `[thread] (no output)` even when the structured result carries the real error.

### Repro

1. Trigger a worker failure that exits before any assistant message is emitted.
2. Let `dispatch` summarize the result.
3. Observe that the returned episode text is `(no output)` while the structured dispatch result still contains `stderr` and/or `errorMessage`.

### Notes

The collapsed done renderer can show `errorMessage`, but the dispatch summary sent back to the parent model still hides the failure. This makes orchestration materially worse because the parent sees a blank-looking result and may retry or misreport success.
