# `/subagents` Selector Crashes At Runtime Due To `pi-tui` API Drift

Date: 2026-03-23
Git version: `418adae` (`refactor: reduce dispatch and metadata branches`)

## BR-009: `/subagents` selector imports a nonexistent `pi-tui` API in the running `pi`

### Expected

Opening `/subagents` should present an interactive selector and accept navigation input without crashing.

### Actual

The selector crashes on input with:

```text
TypeError: (0 , _piTui.getEditorKeybindings) is not a function
    at SubagentSelector.handleInput (/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts:42:48)
```

This happens because the repo imports `getEditorKeybindings` from `@mariozechner/pi-tui`, but the `pi-tui` that the running global `pi` actually loads no longer exports that symbol.

### Evidence

Local repo assumptions:

- [`src/subagents/selector.ts:1`](/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts#L1) imports `getEditorKeybindings`
- [`src/subagents/selector.ts:42`](/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts#L42) calls it
- [`src/types/external-shims.d.ts:168`](/home/bitzaven/CodingProjects/pi-threads/src/types/external-shims.d.ts#L168) declares it, which is why local typecheck does not catch the problem

Running `pi` runtime:

- the crashing `pi` is [`/home/bitzaven/.npm-global/bin/pi`](/home/bitzaven/.npm-global/bin/pi)
- it resolves to [`/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js)
- that package is `@mariozechner/pi-coding-agent` `0.61.1` in [`package.json`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/package.json)
- the nested `pi-tui` actually used at runtime is `0.61.1` in [`package.json`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/package.json)
- that runtime package exports `getKeybindings`, not `getEditorKeybindings`, in [`dist/index.js#L19`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/index.js#L19) through [`dist/index.js#L20`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/index.js#L20)
- the implementation is [`getKeybindings()` in `dist/keybindings.js#L168`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/keybindings.js#L168)

There is also a confusing older global top-level `@mariozechner/pi-tui` `0.52.8` at [`package.json`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-tui/package.json) that still exports `getEditorKeybindings`, but that is not the copy from the stack trace and not the one loaded by the crashing `pi`.

### Second Mismatch

The selector also uses stale command ids:

- [`src/subagents/selector.ts:43`](/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts#L43) through [`src/subagents/selector.ts:57`](/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts#L57) use `selectUp`, `selectDown`, `selectConfirm`, and `selectCancel`
- upstream `SelectList` in the running runtime uses `tui.select.up`, `tui.select.down`, `tui.select.confirm`, and `tui.select.cancel` at [`select-list.js#L65`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/components/select-list.js#L65) through [`select-list.js#L84`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/components/select-list.js#L84)

So even after the symbol import is corrected, the selector should be aligned with the current keybinding command ids too.

### Impact

`/subagents` is not just noisy; it can also hard-crash the interactive selector on input in the user's actual runtime environment.

That makes the feature effectively unusable in the current global `pi` installation.

### Minimal Compatible Fix Shape

1. Switch [`src/subagents/selector.ts`](/home/bitzaven/CodingProjects/pi-threads/src/subagents/selector.ts) from `getEditorKeybindings` to `getKeybindings`
2. Change the command ids to the upstream `tui.select.*` names
3. Update [`src/types/external-shims.d.ts`](/home/bitzaven/CodingProjects/pi-threads/src/types/external-shims.d.ts) to declare `getKeybindings()` instead of `getEditorKeybindings()`
4. Add a reproducer test that would catch the stale API assumption

### Current State For Handoff

- Diagnosis complete
- No reproducer test for this selector runtime drift had been added yet at the time this handoff note was written
- No source fix committed yet
