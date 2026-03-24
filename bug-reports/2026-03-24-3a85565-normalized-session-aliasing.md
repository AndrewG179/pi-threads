Assumptions
- As of 2026-03-24 UTC, `collision/a` and `collision_a` normalize to the same worker session file via `getThreadSessionPath(...)`.
- The intended authority for worker identity is canonical `sessionPath`, not the raw thread label the user typed.
- This report is scoped to the current branch `refactor/explicit-run-state-machine` at `3a85565`.

# Bug

Different thread names that normalize to the same worker session path are still tracked by raw thread label in some bookkeeping paths.

That splits one real worker session across multiple logical records, which can produce:
- duplicate or divergent subagent cards for one worker session
- split accumulated cost/history
- wrong episode numbering across separate dispatches that target the same normalized worker

# Evidence

- Canonical worker-session identity already exists in [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts), where `getThreadSessionPath(...)` normalizes thread names to one `.jsonl` path.
- Before this fix, `episodeCounts` in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts) was keyed by raw `item.thread` during rebuild and by raw `task.thread` during dispatch execution.
- Before this fix, `SubagentRunStore` in [src/subagents/runtime-store.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/runtime-store.ts) keyed parent-session records by raw `thread`, even though each record also carried canonical `sessionPath`.
- The single-batch duplicate check already rejects normalized-path collisions inside one batch, but that does not cover separate dispatches over time.

# Reproduction shape

1. Dispatch to `collision/a`.
2. Later dispatch to `collision_a`.
3. Both resolve to the same normalized `.pi/threads/...jsonl` worker session file.
4. The extension should treat them as one worker session for episode numbering and runtime-store history.
5. Before this fix, they were split by raw label outside the single-batch duplicate check.

# Intended behavior

- Worker identity should be canonicalized on normalized `sessionPath`.
- Raw thread labels should remain presentation metadata only.
- Separate dispatches that target the same normalized worker session should continue episode numbering correctly and reconcile to one runtime-store record for that session.

# Fix shape

1. Key `episodeCounts` by canonical `sessionPath`, not raw thread label.
2. Key `SubagentRunStore` parent-session records by canonical `sessionPath`, not raw thread label.
3. Keep the most recent raw thread label only for display.
4. Add targeted tests for:
   - cross-dispatch alias episode numbering
   - runtime-store alias reconciliation onto one card/history record
