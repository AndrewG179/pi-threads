# `/subagents` Browser Does Not Reliably Replace/Clear the Full Interactive View

Date: 2026-03-23
Git revision: `77ba46bae5db7f4ce3a49fc10ac25f9917b7f2e9` (`77ba46b`)
Evidence basis: user-supplied evidence from a real interactive run, plus static inspection of [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L579) and [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L80); no independent live-drive run was performed for this report.

## Assumptions

- The user-reported run occurred against the current branch state or a materially equivalent build of it.
- `ctx.ui.custom(...)` in [index.ts#L597](/home/bitzaven/CodingProjects/pi-threads/index.ts#L597) is intended to open a distinct interactive browser view, even though the runtime implementation of `custom(...)` is not present in this repository.
- [ui-from-slate.txt#L60](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L60) through [ui-from-slate.txt#L66](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L66) is used here only to support the expectation that `/subagents` is a separate high-level session-navigation view. This report does not claim any stronger layout contract than the user's explicit complaint.

## Summary

On the current branch, `/subagents` opens a custom subagent browser, but the resulting UI is not reliably presented as a clean full-screen replacement. The user observed stale prior chat/tool transcript still visible above the browser header, which indicates a rendering/lifecycle regression: entering `/subagents` does not fully clear or overwrite the interactive viewport before drawing the browser.

## Expected

- Entering `/subagents` should present a distinct browser view that replaces or fully covers the active interactive region.
- No stale transcript lines from the previous task/session should remain visible above the browser UI.
- The existing two-pane browser content is acceptable for this report's scope; the issue is that it should appear as the active full-screen view, not as content drawn lower in the existing transcript.

This expectation is supported by:

- the command path opening a dedicated custom UI via [index.ts#L597](/home/bitzaven/CodingProjects/pi-threads/index.ts#L597) through [index.ts#L599](/home/bitzaven/CodingProjects/pi-threads/index.ts#L599); and
- the Slate reference describing a separate high-level subagent view for navigating sessions at [ui-from-slate.txt#L60](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L60) through [ui-from-slate.txt#L66](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L66).

## Actual

From the user's real run:

- entering `/subagents` did not produce a clean full-screen replacement view;
- stale prior chat/tool output remained visible above the browser UI;
- the visible browser content began lower on the screen with the browser's own header lines:
  - `Subagents`
  - `Current branch only. Up/Down browse, Enter open, Esc close`
  - `Sessions | Selected`
- stale content above that included previous-session/task text such as dispatch/task output, `(no output)`, `Operation aborted`, and `Resumed session`.

Static code inspection matches that symptom:

- `/subagents` opens the browser with `ctx.ui.custom(...)` and passes no explicit options at [index.ts#L597](/home/bitzaven/CodingProjects/pi-threads/index.ts#L597) through [index.ts#L599](/home/bitzaven/CodingProjects/pi-threads/index.ts#L599).
- The browser renders exactly the observed header text at [src/subagents/view.ts#L205](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L205) through [src/subagents/view.ts#L209](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L209).
- The browser body is a fixed-height fragment, not a full-viewport surface:
  - wide mode returns 8 body rows at [src/subagents/view.ts#L184](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L184) through [src/subagents/view.ts#L194](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L194);
  - narrow mode returns 5 session rows plus 7 detail rows at [src/subagents/view.ts#L197](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L197) through [src/subagents/view.ts#L202](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L202);
  - `render(...)` accepts only `width`, not terminal `height`, at [src/subagents/view.ts#L205](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L205);
  - `invalidate()` is empty at [src/subagents/view.ts#L113](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L113).

## Concrete Evidence And Reasoning

- The user-reported `Subagents` and `Current branch only...` lines directly correspond to the current browser renderer in [src/subagents/view.ts#L205](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L205) through [src/subagents/view.ts#L209](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L209). That makes it credible that the lower portion of the screen was the intended `/subagents` browser.
- The stale lines above those headers were reported as prior transcript/task content, not browser chrome. Based on the current renderer, that is consistent with old screen contents remaining visible rather than the browser owning the full viewport.
- I infer the likely failure mode from the implementation shape: this browser returns only a small fixed set of lines and does not know terminal height, pad the rest of the screen, or explicitly clear prior content. If the underlying `custom(...)` runtime does not itself clear and home the screen buffer, stale transcript can remain visible around the browser. This is an inference from [index.ts#L597](/home/bitzaven/CodingProjects/pi-threads/index.ts#L597) through [index.ts#L599](/home/bitzaven/CodingProjects/pi-threads/index.ts#L599) and [src/subagents/view.ts#L113](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L113) through [src/subagents/view.ts#L219](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L219), not a proven root cause inside the external UI runtime.

## Impact

- The `/subagents` browser looks visually corrupted and non-modal.
- Previous task output is mixed into a session-navigation screen, which makes the browser harder to trust and interpret.
- The regression undermines the intended mental model that `/subagents` is a distinct navigation view rather than more transcript appended into the current screen.

## Safest Fix Shape

1. Ensure `/subagents` is mounted as a true full-screen replacement/overlay in the interactive runtime, including an explicit clear/home of the viewport before the first browser frame if the runtime requires that.
2. Make [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts) height-aware and pad/overwrite the full available viewport rather than returning only an 11-16 line fragment.
3. Keep the existing sessions/detail pane structure unless a separate design change is requested; the user explicitly objected to stale content above the browser, not to the sidebar itself.
