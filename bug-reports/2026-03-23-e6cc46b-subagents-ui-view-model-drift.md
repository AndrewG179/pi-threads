# `/subagents` UI Drifted From The Intended View Model In `ui-from-slate.txt`

Date: 2026-03-23
Git version: `e6cc46b` (`fix: align selector with runtime keybindings`)

## Assumptions

- I treat [ui-from-slate.txt](../ui-from-slate.txt) as the intent document for the subagent UX.
- I assume the desired model is:
  - regular chat stays lightweight, showing active actions more like tool calls
  - a separate subagent view is where you inspect cards with richer detail
  - entering that view should replace the editor / become the active view, not appear as a modal overlay
- I assume the user wants the current in-chat expandable dispatch cards removed, not restyled.

## BR-011: current implementation reverses the `ui-from-slate` UX model

### Intended Behavior From `ui-from-slate.txt`

The design note describes this model:

- active actions are shown in the main session almost like parallel tool calls
- the richer subagent inspection UI is a separate high-level view
- you can view all subagents with `ctrl-o`
- you then navigate subagent cards and take over one, then `ctrl-b` returns to the main thread

Relevant intent excerpts from [ui-from-slate.txt](../ui-from-slate.txt):

- “We generally don’t want to show all subthreads at all times.”
- “We just show the active actions that slate is running at a given time, rather than agents.”
- “This actually makes it almost like we are displaying tool calls with a parallel tool calling ui.”
- “You can view all subagents by pressing ctrl-o”
- the subagent view is the place where you inspect cards and enter a subagent session

### Actual

The current implementation does the opposite in two places.

#### 1. `/subagents` is an overlay list, not an independent subagent view

The `/subagents` command currently opens:

- `ctx.ui.custom(..., { overlay: true, overlayOptions: ... })`
- [index.ts#L665](/home/bitzaven/CodingProjects/pi-threads/index.ts#L665) through [index.ts#L673](/home/bitzaven/CodingProjects/pi-threads/index.ts#L673)

And the component it shows is a vertical selector list:

- [`src/subagents/selector.ts`](../src/subagents/selector.ts)

This is explicitly the overlay path, not the full-view path.

Upstream extension docs say:

- non-overlay `ctx.ui.custom()` “temporarily replaces the editor with your component”
- overlay mode is specifically for “a floating modal on top of existing content”
- evidence:
  - [`docs/extensions.md`](../../../../home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md) around lines 1831-1868
  - [`docs/tui.md`](../../../../home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md) around lines 89-127

So the current code is using the wrong UI primitive for the intended subagent view.

#### 2. Rich subagent detail is rendered inline in chat as expandable tool-result cards

Dispatch currently owns a large custom in-chat renderer:

- [`renderResult`](../index.ts) at [index.ts#L861](/home/bitzaven/CodingProjects/pi-threads/index.ts#L861) through [index.ts#L988](/home/bitzaven/CodingProjects/pi-threads/index.ts#L988)

That renderer shows:

- action
- live tool calls
- episode
- usage/model metadata
- collapsed cards with `(Ctrl+O to expand)`

Evidence:

- single-item collapsed tool card adds `(Ctrl+O to expand)` at [index.ts#L964](/home/bitzaven/CodingProjects/pi-threads/index.ts#L964) through [index.ts#L968](/home/bitzaven/CodingProjects/pi-threads/index.ts#L968)
- batch-mode collapsed cards also append `(Ctrl+O to expand)` at [index.ts#L980](/home/bitzaven/CodingProjects/pi-threads/index.ts#L980) through [index.ts#L986](/home/bitzaven/CodingProjects/pi-threads/index.ts#L986)

That means the rich “card” UI currently lives in chat, while `/subagents` is only a selector overlay.

This is the inverse of the intended model from `ui-from-slate.txt`.

### Additional Drift

- The intended entrypoint is `ctrl-o`, but the current extension does not register a `ctrl+o` shortcut for subagent browsing.
- Instead, `ctrl-o` is currently exposed through the tool-card expansion UX, because the rich dispatch renderer is still in chat.

### Impact

- Chat becomes cluttered with rich subagent cards that should live in a dedicated subagent view.
- `/subagents` feels like a modal picker rather than a first-class view.
- The UI teaches the wrong mental model: subagent detail is inline, while the dedicated view is shallow.
- The current experience does not match the intent doc the user is referring to.

### Safest Fix Shape

1. Remove the rich dispatch result card UI from normal chat and reduce it to lightweight action/result summaries, closer to tool-call style.
2. Move the rich multi-card subagent inspection UI into `/subagents`.
3. Implement `/subagents` as a non-overlay `ctx.ui.custom()` view so it replaces the editor while active, instead of floating over chat.
4. Rework the selector/list component into a proper card or pane-based subagent view driven by `SubagentCard` data.
5. Reserve `ctrl-o` for entering that subagent view rather than expanding inline tool cards.

### Notes For Testing

Useful contract tests:

1. dispatch render path should not append `(Ctrl+O to expand)` in chat
2. `/subagents` should invoke `ctx.ui.custom()` without `overlay: true`
3. `/subagents` view should render card/pane summaries from `SubagentCard` data
4. `ctrl-o` should enter the subagent view, and `ctrl-b` should return when a remembered parent exists
