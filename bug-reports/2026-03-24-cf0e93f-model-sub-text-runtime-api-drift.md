Assumptions
- This report is based on worktree branch `fix/model-sub-text-settext-20260324` from `cf0e93f` on 2026-03-24 UTC.
- The installed local dependency tree under `node_modules/` is the runtime evidence source for `@mariozechner/pi-tui`.
- The existing failing reproducer in `.tests/subagents/view-model-contract.test.ts` is the canonical contract for this bug.

# Bug

The `/model-sub` picker mutates `Text` components via `setText(...)`, but the installed `@mariozechner/pi-tui` `Text` runtime does not implement that method.

There are two contributing causes:

1. [`index.ts`](/tmp/pi-threads-model-sub-text-bugfix/index.ts) dynamically imports the raw `Text` export from `@mariozechner/pi-tui` inside `openSubagentModelPicker(...)` and then calls `listText.setText(...)` and `detailText.setText(...)`.
2. [`src/pi/runtime-deps.ts`](/tmp/pi-threads-model-sub-text-bugfix/src/pi/runtime-deps.ts) looks like a compatibility layer, but today it forwards the raw `Text` class unchanged when `@mariozechner/pi-tui` is present, so it does not actually guarantee a mutable `setText(...)` surface.

# Evidence

Reproducer:

- `npm test -- --test-name-pattern '/model-sub picker should use the keybindings object supplied by ctx.ui.custom\(\) for navigation and selection'`
- Result at `cf0e93f`: failure with `TypeError: listText.setText is not a function`
- Stack head:
  - `renderList (.../index.ts:593:14)`
  - `openSubagentModelPicker (.../index.ts:494:31)`
  - `.tests/subagents/view-model-contract.test.ts:841:3`

Direct runtime probe of the installed package:

```bash
node - <<'NODE'
const { createRequire } = require('node:module');
const requireFromRepo = createRequire(process.cwd() + '/package.json');
const { Text } = requireFromRepo('@mariozechner/pi-tui');
const instance = new Text('hello', 0, 0);
console.log(JSON.stringify({
  hasSetText: typeof instance?.setText === 'function',
  protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).sort(),
}, null, 2));
NODE
```

Observed output:

```json
{
  "hasSetText": false,
  "protoMethods": [
    "constructor",
    "invalidate",
    "render"
  ]
}
```

Source evidence for that runtime surface:

- [`node_modules/@mariozechner/pi-tui/index.js`](/tmp/pi-threads-model-sub-text-bugfix/node_modules/@mariozechner/pi-tui/index.js) defines `class Text` with `constructor`, `render`, and `invalidate`, but no `setText`.
- [`index.ts`](/tmp/pi-threads-model-sub-text-bugfix/index.ts) currently calls `setText(...)` on `listText` and `detailText`.
- [`src/types/external-shims.d.ts`](/tmp/pi-threads-model-sub-text-bugfix/src/types/external-shims.d.ts) currently declares `Text#setText(...)` as if it were always available, which masks this runtime mismatch from typecheck.

# Why this matters

- The `/model-sub` picker crashes before it can exercise the keybinding contract that the existing test is meant to cover.
- The code currently depends on a method that is absent in the installed `pi-tui` runtime.
- The local type surface is optimistic in a way that can reintroduce the same failure later.

# Intended behavior

- `/model-sub` should render and update its list/detail text without assuming the raw `pi-tui` `Text` export is mutable.
- The existing `/model-sub` keybinding contract test should pass without any runtime `TypeError`.
- The local compatibility layer and type surface should describe the mutable-text assumption honestly.

# Minimal fix shape

1. Keep the existing failing `/model-sub` contract test as the reproducer.
2. Make [`src/pi/runtime-deps.ts`](/tmp/pi-threads-model-sub-text-bugfix/src/pi/runtime-deps.ts) export a `Text` adapter that always supports `setText(...)`.
3. Stop `openSubagentModelPicker(...)` from shadowing that adapter with the raw `@mariozechner/pi-tui` `Text` export.
4. Update [`src/types/external-shims.d.ts`](/tmp/pi-threads-model-sub-text-bugfix/src/types/external-shims.d.ts) so the raw external `Text` API no longer promises `setText(...)` unconditionally.
