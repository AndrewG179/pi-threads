# `/subagents` Can Intermittently Show No Current-Branch Sessions And No Remembered Parent Before Registry/State Synchronize

Date: 2026-03-23
Git revision: `4b7b354cd4b8b8b25b1e5a00befe05272dc5d342` (`4b7b354`)
Evidence basis: static inspection of [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L446), [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L549), [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L593), [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L621), [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L767), [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L257), [src/subagents/state.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/state.ts#L26), and [src/subagents/mode.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L39), plus user-supplied observation from a real run. No independent live-drive run was performed for this report.

## Assumptions

- The user-reported run happened on this branch or a materially equivalent build.
- The user observation provided with this task is accurate: a real run showed the two intermittent symptoms this report describes, namely `/subagents` appearing to have no current-branch subagents during an active dispatch window, and parent/back-navigation initially reporting no remembered parent before a later retry worked.
- No terminal transcript or screenshot for that run is stored in this repository, so the runtime symptom evidence here is limited to the user report plus the cited code.

## Scope

This report is about selector data availability and parent-session lookup timing. It is not the fullscreen-clearing/rendering issue documented separately in [bug-reports/2026-03-23-77ba46b-subagents-browser-fullscreen-clearing-regression.md](/home/bitzaven/CodingProjects/pi-threads/bug-reports/2026-03-23-77ba46b-subagents-browser-fullscreen-clearing-regression.md).

## Summary

On the current branch, `/subagents` reconstructs its current-branch cards only from completed parent-branch `toolResult` entries for `dispatch`, and subagent parent lookup reads only persisted `state.parentBySession`. That means the reader side depends on asynchronous artifacts that may lag behind live execution:

- if a dispatch is still running and has not yet emitted a completed `toolResult`, `/subagents` can legitimately reconstruct zero cards and appear to have "no subagents";
- if parent-session state has been written but the active session context has not yet synchronized with that persisted state, the first parent lookup can report no remembered parent and a later retry can succeed.

The user reported exactly those two symptoms in a real run, and the current read paths match them.

## Expected

- While a dispatch is in flight for the current parent session, `/subagents` should continue to expose the relevant current-branch thread sessions rather than transiently appearing empty just because completion metadata has not landed yet.
- A subagent session that already has a known parent in the current runtime should not transiently lose back-navigation solely because persisted state/session context synchronization is one step behind.
- These guarantees should hold independently of browser rendering behavior; this bug is about data/source timing, not about fullscreen clearing.

## Actual

- `/subagents` can transiently appear to have no current-branch subagents even though a dispatch from the current parent session is actively running.
- Parent/back-navigation can transiently say there is no remembered parent on the first lookup, then succeed on a later retry after state/session context catches up.
- The user observed exactly that pattern in a real run.

## Concrete Evidence And Reasoning

### 1. Current-branch card discovery only reads completed parent-branch `toolResult` entries

In [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L257), `collectCurrentBranchSessions()` iterates `parentBranchEntries`, but it keeps only entries where:

- `line.type === "message"` at line 263,
- `line.message?.role === "toolResult"` at line 263,
- `line.message.toolName === "dispatch"` at line 264.

It then requires `details.items` at line 267 and derives session paths from those completed dispatch result items at line 271 before inserting them into the session map at line 273.

In [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L280), `collectSubagentCards()` builds cards only by iterating the map returned from `collectCurrentBranchSessions()` at line 285. There is no second source of current-branch sessions there. `mergeParentDispatchDetails()` does not create missing cards; it only mutates cards that already exist, as shown by the `if (!card) continue;` guard in [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L215).

Based on that code, a running dispatch with streamed progress but no completed parent-branch `toolResult` entry yet will produce zero current-branch cards. That exactly explains the intermittent "no subagents" symptom.

### 2. Parent lookup is read only from persisted `state.parentBySession`

In [src/subagents/state.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/state.ts#L26), `loadThreadsState()` reads `.pi/threads/state.json` from disk. The only parent mapping it returns is `parentBySession`, populated from parsed persisted JSON at lines 39-44.

In [src/subagents/mode.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L39), `deriveSessionBehavior()` computes `parentSessionFile` only from `input.state.parentBySession[sessionFile]` at line 42. There is no fallback to live dispatch context, recent browser selection context, or session-branch metadata.

In [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L280), each card's `parentSessionFile` is likewise read only from `state.parentBySession[path.resolve(sessionPath)]` at line 286.

In [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L446), `resolveSessionContext()` reloads state from disk at line 450 and immediately derives behavior from that state at lines 451-455. In [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L549), `switchToRememberedParent()` warns `No remembered parent session for this thread.` at line 551 whenever `behavior.parentSessionFile` is missing.

That is enough to make the failure intermittent instead of permanent: the read side has no source other than persisted `state.parentBySession`, so any early/stale lookup will report no parent even if the runtime already "knows" the intended relationship elsewhere.

### 3. A later retry can work because the write side exists, but the read side has no fallback

This report is not claiming parent mappings are never written.

- `/subagents` writes the mapping on session open via `rememberParentSession(...)` and `saveThreadsState(...)` in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L621) and [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L622).
- `dispatch` also writes parent mappings before worker execution in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L767) through [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L773).

Because those writes exist, a later retry can succeed once `.pi/threads/state.json` and the next `resolveSessionContext()` call are aligned. The intermittent bug is that the read paths cited above do not tolerate the window before that alignment is visible.

## Impact

- `/subagents` can look falsely empty during the exact period when the user most needs it for live dispatch monitoring.
- Subagent sessions can transiently lose trusted back-navigation and emit a misleading "No remembered parent session for this thread." warning even though the relationship may become visible moments later.
- The combined effect is a registry/parent-consistency failure that makes the feature feel unreliable and race-prone.

## Safest Fix Shape

1. Make current-branch session discovery authoritative before completion. The least risky shape is to register thread/session membership when `dispatch` begins, using the already-known thread names and session paths from [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L754), and let completion metadata enrich existing records later instead of being the only source of existence.
2. Add a non-persisted fallback for parent resolution in the current runtime. Persisted `parentBySession` should remain the restart-safe source of truth, but read paths should also consult an in-memory/session-context parent mapping when present so the first lookup is not forced to wait for disk-backed synchronization.
3. Keep this fix scoped to registry/parent data flow. Do not mix it with view clearing, overlay sizing, or fullscreen behavior changes.
