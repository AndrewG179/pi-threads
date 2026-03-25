# Incorrect No-Remembered Handling Creates Duplicate Warning Paths

Date: 2026-03-23
Git revision: `e6cc46b` (`fix: align selector with runtime keybindings`)
Evidence basis: static code review of the current tree plus the current local `.pi/threads/state.json`; no live-drive run was performed for this report.

## Assumptions

- A session should only advertise subagent back-navigation when it has a remembered parent session.
- If a session is not a remembered subagent, the UI should either omit subagent-only affordances or report that state precisely.
- For this report, "duplicate warning paths" means the current UI exposes two back-navigation affordances, `Ctrl+B` and `/subagents-back`, that both funnel into the same no-parent warning for unmapped thread sessions.

## Summary

Any session file under `.pi/threads` is treated as a subagent even when there is no remembered parent mapping. That makes the UI show `parent unknown`, advertises both `Ctrl+B` and `/subagents-back`, wires `Ctrl+B` to the back command, and then routes both paths into the same warning: `No remembered parent session for this thread.`

The result is incorrect no-remembered handling and duplicate warning entry points rather than a clean "this is just a plain thread transcript" state.

## Expected

- Only remembered subagent sessions should show back-navigation affordances.
- A plain thread session with no remembered parent should not claim it can return to a parent.
- If the user does invoke a back action from the wrong place, the warning should distinguish:
  - "this is not a remembered subagent session", versus
  - "this subagent session lost its parent mapping".

## Actual

- [`deriveSessionBehavior()`](../src/subagents/mode.ts) classifies every session under `.pi/threads` as `kind: "subagent"` whether or not `parentSessionFile` exists. See [src/subagents/mode.ts#L39](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L39) through [src/subagents/mode.ts#L52](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L52).
- [`renderSubagentBanner()`](../index.ts) renders the subagent banner for all such sessions, showing `parent unknown` and the copy `Ctrl+B or /subagents-back to return`. See [index.ts#L478](/home/bitzaven/CodingProjects/pi-threads/index.ts#L478) through [index.ts#L492](/home/bitzaven/CodingProjects/pi-threads/index.ts#L492).
- [`syncSessionMode()`](../index.ts) also installs the `Ctrl+B` terminal-input remap for every `subagent` session without checking `behavior.parentSessionFile`. See [index.ts#L528](/home/bitzaven/CodingProjects/pi-threads/index.ts#L528) through [index.ts#L535](/home/bitzaven/CodingProjects/pi-threads/index.ts#L535).
- [`switchToRememberedParent()`](../index.ts) collapses two different states, `behavior.kind !== "subagent"` and `!behavior.parentSessionFile`, into one warning string: `No remembered parent session for this thread.` See [index.ts#L556](/home/bitzaven/CodingProjects/pi-threads/index.ts#L556) through [index.ts#L565](/home/bitzaven/CodingProjects/pi-threads/index.ts#L565).

## Evidence

- The current local state file only records parent mappings for four thread sessions in [`.pi/threads/state.json`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/state.json#L1), while the project currently has eleven thread transcripts under `.pi/threads`:
  - `git-branching.jsonl`
  - `issue-scan.jsonl`
  - `pi-loading.jsonl`
  - `refactor-actor.jsonl`
  - `refactor-core.jsonl`
  - `refactor-integration.jsonl`
  - `refactor-tests.jsonl`
  - `repo-survey.jsonl`
  - `repro-harness.jsonl`
  - `repro-tests.jsonl`
  - `smoke-check.jsonl`
- Given the classification rule in [src/subagents/mode.ts#L43](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L43) through [src/subagents/mode.ts#L52](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L52), any unmapped thread transcript opened directly will still get the subagent banner and back-navigation affordances.
- The documented behavior in [docs/subagents.md#L47](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L47) through [docs/subagents.md#L54](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L54) assumes a remembered parent session for subagent navigation, which the current banner and back handler do not enforce.

## Impact

- Users are told a return path exists when the extension already knows it does not have a parent session.
- Both advertised back actions lead to the same no-parent warning, so the UI duplicates failure paths instead of removing unavailable actions.
- The warning text is ambiguous because it also covers the case where the current session is not meaningfully a remembered subagent at all.

## Safest Fix Shape

1. Separate "thread transcript under `.pi/threads`" from "remembered subagent session" in the session-behavior model, or at minimum gate subagent-only UI on `behavior.parentSessionFile`.
2. Only render the back-navigation banner copy and install the `Ctrl+B` remap when a remembered parent exists.
3. Split the warning cases in [`switchToRememberedParent()`](../index.ts):
   - non-subagent or plain thread session;
   - remembered-subagent metadata missing or stale.
4. Add a navigation test that opens an unmapped `.pi/threads/*.jsonl` session and asserts that no back-navigation affordance is installed and no misleading banner is shown.
