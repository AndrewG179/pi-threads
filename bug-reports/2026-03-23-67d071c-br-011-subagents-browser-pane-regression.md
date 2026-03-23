# BR-011: `/subagents` browser regressed to a stacked list that vertically overflows under constrained height

Date: 2026-03-23
Git revision: `67d071c15862ab04bfb9938ea293f4eb955824e8` (`67d071c`)
Evidence basis: static inspection of [ui-from-slate.txt](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt) and the current uncommitted working-tree implementation in [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts); no live-drive run was performed for this report.

## Assumptions

- [ui-from-slate.txt](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt) is the canonical UX intent for the `/subagents` browser.
- The "clarified /subagents browser regression" in this request refers specifically to browser layout behavior, not to the broader `/subagents` view-model drift already described in other reports.
- The current working-tree [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts) is the implementation the user wants captured, even though it is uncommitted relative to `HEAD`.

## Summary

The current uncommitted `BR-011` browser implementation is a single vertically stacked list with appended detail sections, not a pane- or card-based browser. Under constrained terminal height, it will overflow downward instead of preserving the top/header and presenting the list/detail content within a bounded viewport.

## Expected

Based on [ui-from-slate.txt#L24](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L24) through [ui-from-slate.txt#L46](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L46) and [ui-from-slate.txt#L60](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L60) through [ui-from-slate.txt#L66](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L66):

- the subagent browser should be a high-level session view where each subagent is presented as a richer card/view rather than only as a flat selector row;
- that high-level view should let the user browse sessions while also "tak[ing] a look inside" the selected session;
- when space is constrained, the browser should preserve its framing/header and manage the interior content as a bounded view, rather than letting the entire screen content grow downward unchecked.

## Actual

In the current working-tree [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts):

- `render(width)` only accepts `width`, not `height`, at [src/subagents/view.ts#L65](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L65).
- The method builds one `lines` array for the entire UI and unconditionally pushes:
  - the header at [src/subagents/view.ts#L70](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L70) through [src/subagents/view.ts#L72](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L72),
  - every session row into the same vertical buffer at [src/subagents/view.ts#L80](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L80) through [src/subagents/view.ts#L88](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L88),
  - then the selected-session detail sections after the full list at [src/subagents/view.ts#L90](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L90) through [src/subagents/view.ts#L101](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L101).
- The only clipping applied before return is horizontal `truncateToWidth(...)` at [src/subagents/view.ts#L103](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L103); there is no vertical clipping, pane split, viewport windowing, or header pinning in this component.

## Evidence

- [ui-from-slate.txt#L25](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L25) says "show each subagent as a card", and [ui-from-slate.txt#L26](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L26) through [ui-from-slate.txt#L33](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L33) describe the richer card contents.
- [ui-from-slate.txt#L64](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt#L64) says the high-level view lets the user "take a look inside any of the subagent sessions" while navigating between them.
- The current browser implementation instead renders a plain "Sessions" list followed by a later "Selected" section in the same vertical flow at [src/subagents/view.ts#L80](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L80) through [src/subagents/view.ts#L101](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L101).
- I infer the constrained-height overflow behavior from the implementation shape: because [src/subagents/view.ts#L65](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L65) has no height input and [src/subagents/view.ts#L103](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L103) only truncates width, the component itself does not preserve the header or bound the vertical content when the number of generated lines exceeds the available rows.

## Impact

- The browser does not match the intended card/high-level-view mental model from [ui-from-slate.txt](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt).
- With enough sessions or enough selected-session detail, the most important framing lines at the top are not protected by the component's own layout logic.
- The current layout couples navigation list and detail view into one downward-growing transcript, which makes the browser brittle on shorter terminal heights.

## Safest Fix Shape

1. Convert the browser from a single vertical transcript into an explicit bounded layout with separate list/detail panes or an equivalent card-based viewport.
2. Make vertical layout height-aware so the component can preserve the title/instructions while windowing or clipping interior content.
3. Keep the evidence contract aligned with [ui-from-slate.txt](/home/bitzaven/CodingProjects/pi-threads/ui-from-slate.txt): the browser should expose richer per-subagent inspection than a stacked selector list.
