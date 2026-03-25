# `/subagents` Still Hides Live Current-Branch Child Sessions Until Completion Metadata Lands

Date: 2026-03-23
Evidence basis: static inspection of the current `collectSubagentCards()` implementation in [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L253), the current `/subagents` entry path in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts), the saved reproducer note at [/tmp/subagents-registry-test.txt](/tmp/subagents-registry-test.txt), and the failing contract test in [.tests/subagents/view-model-contract.test.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/view-model-contract.test.ts). No independent live-drive run was performed for this update.

## Assumptions

- A child transcript already present under `.pi/threads/*.jsonl` and mapped back to the active parent session is sufficient evidence that the child belongs to the current parent context, even if the parent has not yet written a completed `dispatch` `toolResult`.
- The saved note in [/tmp/subagents-registry-test.txt](/tmp/subagents-registry-test.txt) accurately captures a previously observed failure shape for this repo.
- This report is only about current-branch child-session visibility while work is still live. It is not the separate remembered-parent/back-navigation timing issue discussed in earlier iterations of this file.

## Summary

The current implementation partially supports live/in-flight child visibility, but only when the browser is given an explicit same-runtime registry map. Without that in-memory registry, `/subagents` still derives current-branch children only from completed `dispatch` `toolResult` entries. That means a real child session can already exist on disk, belong to the current parent, and still remain invisible in `/subagents` until completion metadata lands.

## Expected

- If a child session is already present under `.pi/threads` and belongs to the current parent branch, `/subagents` should continue to show it while the dispatch is still live/in-flight.
- Live current-branch visibility should not depend solely on a same-runtime in-memory registry or on waiting for a completed `toolResult`.

## Actual

- `/subagents` seeds cards from `runtimeSessions` when that map is explicitly provided, or from completed `dispatch` `toolResult` entries.
- If neither of those sources is available yet, the browser renders no current-branch sessions even when a live child transcript already exists and is mapped to the current parent.
- The saved repro note at [/tmp/subagents-registry-test.txt](/tmp/subagents-registry-test.txt) captured exactly that failure shape, and the new test now reproduces it as an expected failure.

## Concrete Evidence And Reasoning

### 1. Completed metadata is still the only branch-derived inclusion source

In [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L253), `collectCurrentBranchSessions()` only accepts parent-branch entries where:

- `line.type === "message"`,
- `line.message?.role === "toolResult"`, and
- `line.message.toolName === "dispatch"`.

It then requires `details.items` and resolves session paths from those completed result items.

So a parent branch that only has a live `dispatch` tool call, but no completed `toolResult`, contributes nothing to current-branch inclusion.

### 2. Same-runtime registry support exists, but only when the caller already has it

In [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L276), `collectSubagentCards()` accepts an optional `runtimeSessions` map and seeds cards from it before it looks at completed branch metadata.

That means the current implementation already has a same-runtime escape hatch for in-flight visibility, but it is not a general current-branch discovery mechanism. If the caller does not have a populated runtime registry, the browser still falls back to completed metadata only.

### 3. The saved repro and new failing test exercise that gap directly

The note at [/tmp/subagents-registry-test.txt](/tmp/subagents-registry-test.txt) captures a reproducer where:

- the parent branch contains only a live `dispatch` tool call;
- the child transcript already exists under `.pi/threads/alpha.jsonl`;
- the child is persisted as belonging to the current parent;
- `/subagents` still renders `No current-branch sessions.` instead of listing `alpha`.

That exact repro shape is now encoded as a failing test in [.tests/subagents/view-model-contract.test.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/view-model-contract.test.ts).

## Impact

- `/subagents` can still look falsely empty during the exact live/in-flight window where the user most needs to inspect or enter a child session.
- Current-branch child visibility depends on completion timing or ephemeral runtime registry state instead of the child session actually existing and belonging to the parent context.

## Reproducer

- Failing contract test:
  - [.tests/subagents/view-model-contract.test.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/view-model-contract.test.ts)
- Saved repro note:
  - [/tmp/subagents-registry-test.txt](/tmp/subagents-registry-test.txt)

Expected failure on the current tree:

- rendered browser output contains `No current-branch sessions.`
- the test expects the live `alpha` child card to remain visible before completion metadata exists

## Safest Fix Shape

1. Treat existing current-branch child transcripts as inclusion candidates before completion, not only after a `toolResult` lands.
2. Keep the same-runtime registry as a useful enrichment source, but do not make it the only non-completion path to live visibility.
3. Keep this fix scoped to current-branch child discovery. Do not mix it with shortcut, fullscreen, or back-navigation behavior changes.
