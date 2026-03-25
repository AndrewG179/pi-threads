Assumptions
- This report is based on branch `refactor/explicit-run-state-machine` at `074050d4de1207f966ef78bd0866e4024133637e` on 2026-03-24 UTC.
- The authoritative evidence for this bug is the final live-drive summary at `/tmp/final-livedrive-after-render-fix.txt` plus the copied crash log at `/tmp/pi-threads-livedrive-after-render-fix-final-artifacts-VKa1Oz/pi-crash.log`.
- I am treating the final corrected live-drive run as authoritative, not the earlier malformed-prompt run.

# Problem

Returning from `/subagents` to the parent while a live child dispatch is still in flight can still crash the parent TUI.

The crash is not in the `/subagents` browser itself. It happens when the parent view re-renders the in-flight dispatch summary after the user escapes back from the inspector/browser.

# Tight problem statement

At `074050d`, the live dispatch summary rendered in the parent view can exceed terminal width on return-to-parent, causing `pi-tui` to throw and terminate the session even though the child run is real and `/subagents` itself remained usable.

# Exact evidence

Final live-drive report:
- `/tmp/final-livedrive-after-render-fix.txt`

Copied crash log:
- `/tmp/pi-threads-livedrive-after-render-fix-final-artifacts-VKa1Oz/pi-crash.log`

Relevant supporting artifact paths cited by the final report:
- final run timeline: `/tmp/pi-threads-livedrive-after-render-fix-final-artifacts-VKa1Oz/timeline.txt`
- parent capture before the fatal return: `/tmp/pi-threads-livedrive-after-render-fix-final-artifacts-VKa1Oz/07-after-first-escape.txt`
- live child transcript proving a real child session existed: `/tmp/pi-threads-livedrive-after-render-fix-final-project-7CVFqy/.pi/threads/live-alpha.jsonl`

# What happened

The final report records:
- `/subagents` opened successfully
- the live child became visible
- inspector open/close worked
- the parent then crashed when control returned to the in-flight parent dispatch summary

The copied crash log records the exact failure:
- `Crash at 2026-03-24T22:13:44.279Z`
- `Terminal width: 120`
- `Line 45 visible width: 129`

The offending rendered line is explicitly recorded as line `[45]`:

`[45] (w=129) ... Run bash command: sleep 8; echo Z. If it succeeds, report the final stdout token and whether the command completed successfully.`

That is the live dispatch action-summary line in the parent render, not a `/subagents` pane line.

# Why this is a real bug

- The child run was real: the final report points to `/tmp/pi-threads-livedrive-after-render-fix-final-project-7CVFqy/.pi/threads/live-alpha.jsonl`, which proves a real worker session existed and started work.
- `/subagents` itself was live enough to show the child before the crash. The failure occurred later, on parent re-render.
- `pi-tui` terminated because the extension emitted a rendered line wider than the terminal. This is a concrete render-contract violation, not a subjective UI oddity.

# Scope

This report is specifically about:
- live child dispatch
- open `/subagents`
- inspect / escape back
- parent summary re-render
- width overflow crash

It is not a report about:
- initial live visibility in `/subagents`
- malformed dispatch prompts
- child completion persistence in general

# Suspected boundary

Based on the crash log and final report, the likely offending surface is the parent live dispatch summary rendering path, where the action text for an in-flight item is emitted without sufficient truncation/wrapping for the current terminal width during return-to-parent.
