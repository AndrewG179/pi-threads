# BR-011: `/subagents` browser ignores `ctx.ui.custom(...)` keybindings and imports a missing `pi-tui` API

Date: 2026-03-23
Git revision: `67d071c15862ab04bfb9938ea293f4eb955824e8` (`67d071c`)
Evidence basis: static inspection of the current working tree in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts), [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts), and [node_modules/@mariozechner/pi-tui/index.js](/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js), plus a verified runtime import using `bun -e "import './index.ts'"` from `/home/bitzaven/CodingProjects/pi-threads`.

## Assumptions

- The installed package at [node_modules/@mariozechner/pi-tui/index.js](/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js) is the package Bun resolves for the verified `bun -e "import './index.ts'"` run. This is supported by the runtime error path.
- The third argument in the `ctx.ui.custom(...)` factory signature is the runtime keybindings object intended for custom UI components. This is supported by the typed callback signature in [index.ts#L568](/home/bitzaven/CodingProjects/pi-threads/index.ts#L568) through [index.ts#L573](/home/bitzaven/CodingProjects/pi-threads/index.ts#L573).

## Expected

The `/subagents` browser should consume the keybindings object supplied by `ctx.ui.custom(...)` and should not import a nonexistent keybinding helper from the installed `@mariozechner/pi-tui` package. Importing [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts) should succeed under the repo's installed dependencies.

## Actual

- [index.ts#L597](/home/bitzaven/CodingProjects/pi-threads/index.ts#L597) through [index.ts#L599](/home/bitzaven/CodingProjects/pi-threads/index.ts#L599) constructs `SubagentBrowser` with `(cards, theme, done)` and explicitly discards the supplied `_keybindings` argument.
- [src/subagents/view.ts#L1](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L1) imports `getKeybindings` directly from `@mariozechner/pi-tui`, and [src/subagents/view.ts#L42](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L42) through [src/subagents/view.ts#L59](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L59) use that imported helper instead of any keybindings object from `ctx.ui.custom(...)`.
- The installed package at [node_modules/@mariozechner/pi-tui/index.js#L52](/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js#L52) through [node_modules/@mariozechner/pi-tui/index.js#L74](/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js#L74) defines and exports `getEditorKeybindings`, not `getKeybindings`.
- The verified runtime command fails before startup:

```text
$ bun -e "import './index.ts'"
1 | })
2 | {
    ^
SyntaxError: Export named 'getKeybindings' not found in module '/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js'.
      at loadAndEvaluateModule (2:1)

Bun v1.3.5 (Linux x64)
```

## Evidence

- The `ctx.ui.custom(...)` factory type includes a `keybindings` parameter at [index.ts#L568](/home/bitzaven/CodingProjects/pi-threads/index.ts#L568) through [index.ts#L573](/home/bitzaven/CodingProjects/pi-threads/index.ts#L573).
- The actual `/subagents` browser invocation ignores that parameter at [index.ts#L597](/home/bitzaven/CodingProjects/pi-threads/index.ts#L597) through [index.ts#L599](/home/bitzaven/CodingProjects/pi-threads/index.ts#L599).
- `SubagentBrowser` has no constructor parameter for keybindings at [src/subagents/view.ts#L36](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L36) through [src/subagents/view.ts#L40](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L40), which is consistent with the dropped `_keybindings` argument in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts).
- `SubagentBrowser.handleInput(...)` calls `getKeybindings()` directly at [src/subagents/view.ts#L42](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L42) through [src/subagents/view.ts#L59](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L59).
- The installed `@mariozechner/pi-tui` entrypoint exports `getEditorKeybindings` and does not export `getKeybindings` at [node_modules/@mariozechner/pi-tui/index.js#L52](/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js#L52) through [node_modules/@mariozechner/pi-tui/index.js#L74](/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js#L74).
- The verified runtime command `bun -e "import './index.ts'"` exits with code `1` and reports that exact missing export from `/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js`.

## Impact

- The current repo cannot import [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts) under the installed dependency set, so the `/subagents` browser regression is a startup-time runtime failure, not just a degraded interaction bug.
- Even if the missing export were corrected independently, the browser would still ignore runtime-supplied custom keybindings because [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts) drops the `keybindings` object and [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts) does not accept one.

## Safest Fix Shape

1. Thread the `keybindings` object from `ctx.ui.custom(...)` into `SubagentBrowser` instead of discarding it in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts).
2. Remove the direct `getKeybindings` import from [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts), since it is incompatible with the installed [node_modules/@mariozechner/pi-tui/index.js](/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js) and bypasses runtime-injected bindings anyway.
3. Re-run `bun -e "import './index.ts'"` after the change as the minimum runtime reproducer for this regression.

## Current State For Handoff

- Canonical report written for the runtime keybindings regression requested here.
- No source fix was applied in this task.
- No files other than this new report and the requested `/tmp` pointer file were edited.
