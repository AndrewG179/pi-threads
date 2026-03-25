Assumptions
- This report is based on `/home/bitzaven/CodingProjects/pi-threads` at `20c527c325ac0ae93b06a2ec9c3874ecbadf278c` on 2026-03-25 UTC.
- I used the existing diagnostics as primary evidence and did not redo broad exploration:
  - `temp/2026-03-25-subagents-render-history-diagnosis.md`
  - `temp/2026-03-25-subagents-render-bug-diagnosis.md`
- I assume the user-reported corruption refers to the live `/subagents` browser showing transcript fragments or repeated `...` because it is composited over existing editor content rather than replacing that content.

# Problem

`/subagents` is mounted with `ctx.ui.custom(..., { overlay: true })` in `index.ts`, so the host treats it as a floating overlay composited over the existing live transcript instead of as a replacement custom view. That makes the browser vulnerable to visible transcript bleed-through and overdraw-style corruption even when the `SubagentBrowser` render output itself is clean.

# Evidence

- Current mount site: `index.ts` opens `/subagents` with `overlay: true` and full-screen overlay options.
- Static diagnosis in `temp/2026-03-25-subagents-render-bug-diagnosis.md` cites the host contract:
  - normal `ctx.ui.custom()` replaces the editor
  - overlay mode is a floating modal rendered on top of existing content without clearing it
- The same diagnosis cites the installed `pi-tui` compositor behavior: overlay lines are merged into existing rendered lines rather than owning a clean screen.
- `temp/2026-03-25-subagents-render-history-diagnosis.md` says the likely origin of the current broken-looking `/subagents` behavior predates `20c527c` and most likely traces back to `69c9b31`, so this is not explained by the latest selected-pane compacting patch alone.
- The existing contract test in `.tests/subagents/view-model-contract.test.ts` currently expects `/subagents` to use overlay mode. That means the wrong UI primitive is encoded as accepted behavior today.

# Tight problem statement

As of `20c527c`, `/subagents` uses the host's overlay path even though the feature is intended to behave like a session-scoped live browser view. Because overlays are composited over the current transcript, the browser can show rendering corruption that looks like repeated `...`, stale transcript fragments, or overdraw from the underlying editor.

# Why this is a bug

- The repo's own diagnostics point to the UI primitive, not the run-store data, as the strongest explanation for the corruption.
- A live browser view should own the editor region it renders into. Overlay mode explicitly does not.
- Keeping `/subagents` as an overlay bakes the corruption risk into the feature contract, regardless of whether `SubagentBrowser` itself pads to terminal height.

# Fix shape

- Update the `/subagents` contract test so it rejects overlay mounting for this command.
- Change `index.ts` so `/subagents` calls plain `ctx.ui.custom(...)` with no overlay options.
- Leave other overlay-backed UI, such as `/model-sub`, unchanged unless there is separate evidence they are wrong.
