# `ctrl+o` Shortcut Conflict Should Not Be Part Of The Extension Contract

Date: 2026-03-23
Evidence basis: static inspection of the current extension code in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L851), the locally installed host keybinding docs at [`@mariozechner/pi-coding-agent/docs/keybindings.md`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/keybindings.md#L121), the local host extension-runner shortcut-conflict logic at [`/tmp/jiti/extensions-runner.fc91ac0b.cjs`](/tmp/jiti/extensions-runner.fc91ac0b.cjs#L220), and the new failing contract test in [.tests/subagents/view-model-contract.test.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/view-model-contract.test.ts). No live-drive run was performed for this report.

## Assumptions

- I treat [docs/subagents.md](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L3) as the current extension-facing user contract for this repo unless the user explicitly overrides it.
- The user explicitly asked for this cycle to treat "`ctrl+o` shortcut conflict should not exist in the extension contract" as the target behavior.
- I assume the local installed `pi` host docs and extension runner are representative of the runtime this extension is meant to load into on this machine.

## Summary

The current extension hard-registers `ctrl+o` for `/subagents`, but the local host already documents `ctrl+o` as the built-in `app.tools.expand` shortcut and has explicit conflict-handling logic for extension shortcuts that overlap built-ins. That means the extension currently bakes a shortcut conflict into its public contract instead of avoiding it.

## Expected

- The extension contract should expose `/subagents` through its explicit command surface without reserving `ctrl+o`.
- A repo-local extension should not claim a host-reserved keybinding as part of its normal contract when the host already assigns that key.

## Actual

- The extension registers `ctrl+o` unconditionally in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L851).
- The locally installed host documents `ctrl+o` as built-in `app.tools.expand` in [`docs/keybindings.md`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/keybindings.md#L121).
- The local extension runner emits diagnostics for extension shortcuts that collide with built-ins in [`/tmp/jiti/extensions-runner.fc91ac0b.cjs`](/tmp/jiti/extensions-runner.fc91ac0b.cjs#L220).

## Evidence

1. The extension currently advertises only `/threads on`, `/threads off`, and `/subagents` in [docs/subagents.md](/home/bitzaven/CodingProjects/pi-threads/docs/subagents.md#L3). There is no corresponding documented `ctrl+o` contract there.
2. The runtime code nevertheless registers `ctrl+o` directly in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L851) through [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L858).
3. The local host keybinding docs reserve `ctrl+o` for `app.tools.expand` in [`@mariozechner/pi-coding-agent/docs/keybindings.md`](/home/bitzaven/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/keybindings.md#L121).
4. The local extension runner checks extension shortcuts against built-in bindings and records a warning when they overlap in [`/tmp/jiti/extensions-runner.fc91ac0b.cjs`](/tmp/jiti/extensions-runner.fc91ac0b.cjs#L220) through [`/tmp/jiti/extensions-runner.fc91ac0b.cjs`](/tmp/jiti/extensions-runner.fc91ac0b.cjs#L227).

## Impact

- The extension contract conflicts with the host’s own default keyboard contract.
- Shortcut behavior becomes host-dependent and warning-prone instead of being explicit and stable at the extension layer.
- Tests that assert `ctrl+o` is a supported `/subagents` entry path are reinforcing a conflict rather than catching it.

## Reproducer

The failing contract test now asserts that `ctrl+o` should not be registered by the extension:

- [.tests/subagents/view-model-contract.test.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/view-model-contract.test.ts)

Expected failure on the current tree:

- the extension still registers `ctrl+o`
- the test therefore sees a real shortcut handler instead of `undefined`

## Safest Fix Shape

1. Remove the extension-level `ctrl+o` registration.
2. Keep `/subagents` reachable via the explicit command contract for now.
3. If a dedicated hotkey is reintroduced later, pick one that does not collide with the host’s built-in keybindings on the actual runtime.
