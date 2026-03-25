Assumptions
- I treat the tmux pane snapshots in `/tmp/pi-threads-postfix-W3kktM/artifacts` as the authoritative user-visible evidence for the live TUI behavior.
- I treat commit `7b82713` as the broken baseline for this report, based on `git log --oneline -n 6` in this repo on 2026-03-23 UTC.

# Bug: blocked subagent navigation silently exits the browser on `7b82713`

## Summary

On commit `7b82713`, selecting a real child from `/subagents` while the parent still has an active `dispatch` does not kill the parent anymore, but it still fails the intended UX. The session switch is cancelled and the browser exits, so the user sees `Resumed session` in the parent instead of a visible block state.

## Evidence

Live-drive report:
- [`/tmp/subagents-postfix-livedrive.txt`](/tmp/subagents-postfix-livedrive.txt)

Positive control showing real entry into a child works when no parent dispatch is active:
- [`04b-after-enter-probe-subagent.txt`](/tmp/pi-threads-postfix-W3kktM/artifacts/04b-after-enter-probe-subagent.txt)

Guarded browser state with the real child selected during the active parent dispatch:
- [`06b-subagents-browser-probe-selected-during-guard.txt`](/tmp/pi-threads-postfix-W3kktM/artifacts/06b-subagents-browser-probe-selected-during-guard.txt)

Broken result immediately after `Enter`:
- [`06c-after-probe-open-attempt-during-guard.txt`](/tmp/pi-threads-postfix-W3kktM/artifacts/06c-after-probe-open-attempt-during-guard.txt)

Parent and child both still alive after the guarded attempt:
- [`06d-pstree-after-open-attempt.txt`](/tmp/pi-threads-postfix-W3kktM/artifacts/06d-pstree-after-open-attempt.txt)

## Observed behavior

- `/subagents` opens and lists the real child correctly.
- Selecting that child while the parent dispatch is active exits the browser.
- The parent screen shows `Resumed session` and `threads:on`.
- No visible `Blocked session switch...` warning is shown in the live TUI.
- The parent and child processes both remain alive.

## Expected behavior

- Unsafe subagent navigation should remain visibly blocked.
- The browser should stay open and show the block reason inline, or otherwise keep the blocked state visible to the user.
- The extension should not silently dump the user back to the parent view.

## Diagnosis

Based on reading [`index.ts`](/home/bitzaven/CodingProjects/pi-threads/index.ts) on `7b82713`, the browser closed before the result of `switchSession()` was known:

- `/subagents` awaited `ctx.ui.custom(...)`, which resolves only after `done(...)` is called.
- The selected child was returned from the browser first.
- Only after the overlay had already closed did the command call `switchSession(selected.sessionPath)`.
- If the host then cancelled the switch through `session_before_switch`, there was no browser view left to render the block state into.

So the root bug is not the guard decision itself. The bug is that the blocked decision is surfaced too late in the UI lifecycle.

## Fix shape

- Preflight the unsafe switch before leaving the browser.
- Keep `/subagents` open when the switch is blocked.
- Render the block message inline in the browser.
- For `/subagents-back`, refuse the switch before calling `switchSession()` and notify immediately.
