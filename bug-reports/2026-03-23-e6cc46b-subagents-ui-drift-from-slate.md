# `/subagents` UI Has Drifted From `ui-from-slate.txt`

Date: 2026-03-23
Git revision: `e6cc46b` (`fix: align selector with runtime keybindings`)
Evidence basis: static comparison between `ui-from-slate.txt` and the current `/subagents` and `dispatch` UI code; no live-drive run was performed for this report.

## Assumptions

- For this task, [ui-from-slate.txt](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt) is the intended UX reference.
- The important Slate intent is:
  - keep the main orchestration chat lightweight by showing active actions rather than full subagent detail;
  - provide a distinct subagent-navigation view for deeper inspection and handoff.
- [docs/subagents.md](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md) is currently descriptive of the implementation, not authoritative over the Slate UX reference the user asked to compare against.

## Summary

The current implementation splits subagent visibility across two places:

- a `/subagents` overlay list that opens on command, and
- heavyweight in-chat `dispatch` result cards that show per-thread action, activity, episode, usage, and `(Ctrl+O to expand)`.

That drifts away from the Slate writeup in `ui-from-slate.txt`, which describes a lightweight main chat that shows active actions, plus a separate subagent view for navigating and taking over sessions.

## Expected

Based on [ui-from-slate.txt](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt):

- the main session should avoid showing all subthreads at once and instead show active actions in a lightweight, tool-call-like way. See [ui-from-slate.txt#L49](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L49) through [ui-from-slate.txt#L54](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L54).
- there should be a distinct high-level subagent view for browsing sessions and taking over one directly. See [ui-from-slate.txt#L55](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L55) through [ui-from-slate.txt#L66](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L66).

## Actual

- `/subagents` is implemented as an interactive overlay selector opened by command, not as a first-class separate subagent view. See [index.ts#L643](/home/bitzaven/CodingProjects/pi-threads/index.ts#L643) through [index.ts#L676](/home/bitzaven/CodingProjects/pi-threads/index.ts#L676) and [src/subagents/selector.ts#L64](/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts#L64) through [src/subagents/selector.ts#L110](/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts#L110).
- The main chat carries a substantial amount of subagent detail directly inside `dispatch` tool results:
  - running state shows action text, live tool calls, and usage stats in-chat at [index.ts#L878](/home/bitzaven/CodingProjects/pi-threads/index.ts#L878) through [index.ts#L914](/home/bitzaven/CodingProjects/pi-threads/index.ts#L914);
  - expanded done state shows action, full activity list, episode, and usage at [index.ts#L917](/home/bitzaven/CodingProjects/pi-threads/index.ts#L917) through [index.ts#L950](/home/bitzaven/CodingProjects/pi-threads/index.ts#L950);
  - collapsed state still shows the episode inline at [index.ts#L953](/home/bitzaven/CodingProjects/pi-threads/index.ts#L953) through [index.ts#L959](/home/bitzaven/CodingProjects/pi-threads/index.ts#L959);
  - the UI explicitly prompts `(Ctrl+O to expand)` inside the chat transcript at [index.ts#L965](/home/bitzaven/CodingProjects/pi-threads/index.ts#L965) through [index.ts#L969](/home/bitzaven/CodingProjects/pi-threads/index.ts#L969) and [index.ts#L976](/home/bitzaven/CodingProjects/pi-threads/index.ts#L976) through [index.ts#L987](/home/bitzaven/CodingProjects/pi-threads/index.ts#L987).

## Evidence

- `ui-from-slate.txt` says the product should generally avoid showing all subthreads at all times and instead show active actions in the main session. See [ui-from-slate.txt#L49](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L49) through [ui-from-slate.txt#L54](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L54).
- `ui-from-slate.txt` then describes a distinct session-browser view for subagents, entered separately and used for handoff. See [ui-from-slate.txt#L60](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L60) through [ui-from-slate.txt#L66](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L66).
- The current repo instead places rich subagent inspection inside the normal chat transcript through `dispatch.renderResult(...)` in [index.ts#L861](/home/bitzaven/CodingProjects/pi-threads/index.ts#L861) through [index.ts#L991](/home/bitzaven/CodingProjects/pi-threads/index.ts#L991).
- The current docs already encode that implementation drift by defining `/subagents` as an overlay and subagent sessions as normal chats with only a small banner. See [docs/subagents.md#L28](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L28) through [docs/subagents.md#L29](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L29) and [docs/subagents.md#L47](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L47) through [docs/subagents.md#L54](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L54).

## Impact

- The orchestrator chat becomes a mixed log of orchestration plus subagent internals instead of staying lightweight.
- Rich inspection is split between chat cards and the selector overlay, so the UX has no single clear "subagent view".
- The current `(Ctrl+O to expand)` in-chat affordance conflicts with the Slate writeup, which uses `Ctrl+O` for viewing all subagents.
- Because the docs have already drifted to describe the current overlay-and-banner model, future work is likely to reinforce the wrong UX unless the canonical intent is re-established.

## Safest Fix Shape

1. Keep `dispatch` results in the main chat lightweight: thread, status, brief action/episode summary, and minimal cost/status data only.
2. Move rich subagent inspection, activity history, and takeover selection into a dedicated subagent view rather than expandable in-chat cards.
3. Make `/subagents` open that dedicated view, and add or restore a first-class hotkey that maps to the same screen.
4. Recohere the docs after the behavior change:
   - update [docs/subagents.md](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md) to point at the canonical UX intent;
   - avoid duplicating contradictory normative rules between the docs and `ui-from-slate.txt`.
