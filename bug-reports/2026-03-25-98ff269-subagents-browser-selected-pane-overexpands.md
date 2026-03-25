Assumptions
- This report is based on `/home/bitzaven/CodingProjects/pi-threads` at `98ff2695d476238e8816a8839379553c8ad62a0e` on 2026-03-25 UTC.
- The user-reported evidence is the pasted `/subagents` browser screenshot in this thread.
- The local reproduction evidence is a direct `SubagentBrowser` render using six `subagents-*` cards at width `120` and rows `24`, executed from the current code without modification.

# Problem

The `/subagents` browser selected pane has become too verbose in browser mode. With several long-named `subagents-*` cards, the right-side `Selected` pane expands into a partial inspector and visually overwhelms the session list.

This is not an inspector-mode bug. It happens in normal browser mode before the user presses `Enter`.

# Tight problem statement

At `98ff269`, browser mode can allocate enough `Action` and `Output` rows that the right pane stops feeling like a compact browser summary and starts behaving like a half-open inspector. In a session with many cards, this makes the browser look broken and makes the selected row harder to visually track.

# Exact evidence

User report in-thread:
- `/subagents` showed a two-pane browser with many `subagents-*` rows on the left and an over-expanded selected detail pane on the right.

Local reproduction:
- Direct render from current `SubagentBrowser` using six `subagents-*` cards at width `120`, rows `24`.
- Key rendered rows from that reproduction:
  - row 7: `Work only in the worktree at /tmp/pi-threads-native-child-chat.`
  - row 11: `src/dispatch/journal.ts. Summarize the implemented architecture and`
  - row 19: `- native child opening = browser returns sessionPath, then host`
  - row 20: `switchSession(...)`

Those rows all appear in browser mode, not inspector mode.

# Why this is a real bug

- Browser mode is supposed to be an overview surface. Full detail belongs behind `Enter inspect`, per the current browser header text in `src/subagents/view.ts`.
- The current browser selected pane now exposes enough wrapped `Action` and `Output` detail that it visually competes with the actual list navigation pane.
- This regression is caused by current browser-mode line budgets in `src/subagents/view.ts`, especially `BROWSER_SECTION_CAPS = [20, 10, 2]`, combined with the wide two-pane layout.

# Suspected boundary

The bug is localized to browser-mode rendering in:
- `src/subagents/view.ts`

Specifically:
- browser selected-pane budgets are too generous for multi-card browsing
- browser mode currently reuses much of the same detail content as inspector mode instead of staying summary-oriented

# Intended fix shape

- Keep inspector mode as the place for full detail.
- Keep browser mode compact, especially when several cards exist.
- Reduce browser-mode selected-pane expansion enough that it stays legible as a summary pane rather than a partial inspector.
