Date: 2026-03-25
Branch: `fix/subagents-browser-layout-compact`
Evidence basis: real tmux live-drive using a reopened parent session with persisted `dispatch` history, captured by [.tests/subagents/browser-layout-livedrive.repro.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/browser-layout-livedrive.repro.ts) before the renderer fix.

## Assumptions

- The installed `pi` host on this machine is the runtime the user cares about.
- The parent session artifact at [/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/03-parent-session-final.jsonl](/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/03-parent-session-final.jsonl) is valid because it was created by a real `pi` session, not hand-written.
- The reopened browser capture at [/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/05-reopened-subagents-browser.txt](/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/05-reopened-subagents-browser.txt) reflects the current working-tree implementation in [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts).

## Summary

`/subagents` does load real historical child runs when the parent session actually contains persisted `dispatch` results, but the browser renderer is still visibly broken at runtime. In a wide tmux capture, browser rows gain stray right-edge `...` markers and the two-pane layout becomes visually noisy and over-selected.

## Reproduction

1. Run [.tests/subagents/browser-layout-livedrive.repro.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/browser-layout-livedrive.repro.ts).
2. The script:
   creates a real parent session with one real completed `dispatch` child run;
   reopens `pi` on that exact same parent session file;
   sends `/subagents` in tmux;
   captures the reopened browser screen.
3. Before the fix, the script fails on the reopened browser capture.

## Evidence

- The parent session really contains a persisted `dispatch` tool result at [/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/03-parent-session-final.jsonl](/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/03-parent-session-final.jsonl).
- The reopened browser capture at [/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/05-reopened-subagents-browser.txt](/tmp/pi-threads-browser-layout-livedrive-CXWAr5/artifacts/05-reopened-subagents-browser.txt) shows:
  - `Subagents                                                                                                  ...`
  - `Current session only. Up/Down browse, Enter inspect, Esc close                               ...`
  - `Sessions              ...                         | Selected         ...`
  - selected-pane rows with the same stray right-edge `...`
- The capture also shows the correct card data, including `[alpha]` and `CHILD-DONE-ALPHA`, so this is not a history-loading failure.

## Impact

- The browser is not trustworthy as a compact overview.
- The broken runtime paint obscures whether truncation is intentional or accidental.
- The current styling/padding approach is a plausible regression source because the bad `...` appears on rows whose visible content already fits the wide terminal.

## Likely Fix Direction

- Cut the browser back to a simpler compact renderer closer to the older fixed-preview layout.
- Avoid styled full-width browser rows and background-highlighted padded strings in browser mode.
- Keep the inspector behind `Enter`, but make browser navigation request a re-render explicitly after state changes.
