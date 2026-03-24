Assumptions
- This report is based on branch `refactor/explicit-run-state-machine` at `a2f953a` on 2026-03-24 UTC.
- The host-supplied `ctx.ui.custom(...)` keybindings matcher is the canonical interactive input contract for custom TUI views in this extension.

# Bug

The `/model-sub` interactive picker hardcodes raw terminal escape sequences for navigation/confirm/cancel instead of using the `keybindings` matcher supplied by `ctx.ui.custom(...)`.

# Evidence

- The `/subagents` browser already uses the supplied keybindings abstraction in [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts).
- The `/model-sub` picker factory currently receives a `keybindings` parameter but ignores it in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts).
- The picker currently branches on raw `\x1b[A`, `\x1b[B`, `\r`, `\n`, `\x1b`, and `\x03`, which makes the behavior depend on terminal escape sequences rather than the host input abstraction.

# Why this matters

- It is inconsistent with the rest of the extension’s interactive view model.
- It is brittle under hosts or wrappers that remap keys or provide non-raw keybinding events.
- It weakens the extension contract precisely where the code should be relying on the host abstraction.

# Intended behavior

- If `ctx.ui.custom(...)` supplies a `keybindings` matcher, the `/model-sub` picker should use that matcher for up/down/confirm/cancel.
- Raw escape sequences should only be a fallback when no matcher is available.

# Fix shape

1. Add a focused contract test proving the picker honors the supplied keybindings matcher.
2. Update the `/model-sub` picker to use the matcher for `tui.select.up`, `tui.select.down`, `tui.select.confirm`, and `tui.select.cancel`.
3. Keep the raw escape handling only as a no-matcher fallback.
