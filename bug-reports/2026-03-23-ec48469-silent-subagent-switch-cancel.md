## Bug

Active parent `dispatch` runs can be silently cancelled or silently bounced when the user navigates with `/subagents` or `/subagents-back`.

## Date / commit

- Date: 2026-03-23 UTC
- Observed on branch tip: `ec48469`

## Assumptions

- I assume the authoritative evidence for this bug is the real tmux live-drive, not the unit tests.
- I assume a user-visible fix must explain the blocked navigation in the same session where the command was issued.

## Evidence

Real tmux live-drive report:
- [/tmp/subagents-parent-stop-livedrive.txt](/tmp/subagents-parent-stop-livedrive.txt)

Primary artifacts from that run:
- parent/session raw log: [/tmp/pi-threads-livedrive-FEa8YC/tmux-pane.log](/tmp/pi-threads-livedrive-FEa8YC/tmux-pane.log)
- parent after dispatch starts: [/tmp/pi-threads-livedrive-FEa8YC/captures/04-parent-dispatch-submitted.txt](/tmp/pi-threads-livedrive-FEa8YC/captures/04-parent-dispatch-submitted.txt)
- entered live subagent while parent was active: [/tmp/pi-threads-livedrive-FEa8YC/captures/05-subagents-browser-while-parent-running.txt](/tmp/pi-threads-livedrive-FEa8YC/captures/05-subagents-browser-while-parent-running.txt)
- parent after `/subagents-back`: [/tmp/pi-threads-livedrive-FEa8YC/captures/06-after-subagents-back.txt](/tmp/pi-threads-livedrive-FEa8YC/captures/06-after-subagents-back.txt)
- parent still stalled after waiting: [/tmp/pi-threads-livedrive-FEa8YC/captures/07-parent-state-after-wait.txt](/tmp/pi-threads-livedrive-FEa8YC/captures/07-parent-state-after-wait.txt)
- final parent check: [/tmp/pi-threads-livedrive-FEa8YC/captures/08-parent-final-check.txt](/tmp/pi-threads-livedrive-FEa8YC/captures/08-parent-final-check.txt)

Follow-up live-drive on the partial guard patch:
- browser showed a real live child candidate: [/tmp/pi-threads-live-20260323T185348Z-g1SA/artifacts/05b-after-subagents-enter.txt](/tmp/pi-threads-live-20260323T185348Z-g1SA/artifacts/05b-after-subagents-enter.txt)
- after `Enter`, the UI returned to the parent with `Resumed session` and no warning: [/tmp/pi-threads-live-20260323T185348Z-g1SA/artifacts/06-after-subagent-open-attempt.txt](/tmp/pi-threads-live-20260323T185348Z-g1SA/artifacts/06-after-subagent-open-attempt.txt)

## Smallest accurate problem statement

The extension correctly identifies unsafe session switches in `session_before_switch`, but the visible warning was attached only to that event path. In the real TUI flow, the host can cancel the switch and return `Resumed session` without surfacing that warning back through `/subagents` or `/subagents-back`. The result is a silent or confusing navigation failure.

## Expected

- Unsafe navigation into or out of a subagent while the parent dispatch is still active should be blocked.
- The user should see an explicit warning in the command path that initiated the blocked switch.

## Actual

- The switch may be cancelled, but the user sees `Resumed session` with no clear explanation.
- In the original live-drive, the parent also ended up apparently stopped after the subagent visit.

## Fix direction

- Keep the hard cancel in `session_before_switch`.
- Surface the warning from `/subagents` and `/subagents-back` when `switchSession()` returns `{ cancelled: true }` for an unsafe parent/subagent transition.
