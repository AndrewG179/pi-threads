# Subagent Navigation Regressions

Date: 2026-03-21
Git version: `41927bd` (`feat: add subagent session controls`)

## BR-006: `dispatch` does not remember the parent session for spawned thread sessions

### Expected

When a parent session dispatches work to a thread, opening that thread later should treat it as a subagent session with a remembered parent. That is required by the documented behavior in [docs/subagents.md](../docs/subagents.md#L43), especially the return path in lines 49-54.

### Actual

Parent-session mappings are only written in the `/subagents` command flow at [index.ts:601](../index.ts#L601) through [index.ts:645](../index.ts#L645). The `dispatch` tool execution path at [index.ts:681](../index.ts#L681) through [index.ts:770](../index.ts#L770) never calls `rememberParentSession()` or `saveThreadsState()`, even though it knows the child `sessionPath` for every thread at [index.ts:735](../index.ts#L735).

As a result, a thread created or reused through normal `dispatch` use has no `parentBySession` entry in `.pi/threads/state.json`. If the user later opens that thread session, it shows `parent unknown` and cannot navigate back to the originating parent session.

### Repro

1. Start in a normal persisted parent session.
2. Turn thread mode on with `/threads on`.
3. Run `dispatch [smoke-fast] Respond with exactly: hello`.
4. Open `.pi/threads/smoke-fast.jsonl` as a session.
5. Observe that the subagent banner has no remembered parent and `/subagents-back` cannot return to the parent session.

### Notes

This is a behavioral gap, not just missing metadata in the selector. The current implementation only remembers parent linkage when the user enters a thread through `/subagents`, not when the thread is born from `dispatch`, which is the primary entry path.

## BR-007: `Ctrl+B` is implemented against the wrong runtime context type

### Expected

Inside a subagent session, `Ctrl+B` should return to the remembered parent session, matching [docs/subagents.md](../docs/subagents.md#L49).

### Actual

The extension registers `Ctrl+B` at [index.ts:594](../index.ts#L594) and calls `switchToRememberedParent(ctx)` at [index.ts:596](../index.ts#L596). That helper requires `ctx.switchSession()` at [index.ts:515](../index.ts#L515) through [index.ts:531](../index.ts#L531).

Upstream does not provide `switchSession()` to shortcut handlers:

- `ExtensionCommandContext` owns `switchSession()` in upstream [`types.ts:294-317`](/home/bitzaven/CodingProjects/CasparPI/source-code/pi-mono/packages/coding-agent/src/core/extensions/types.ts#L294)
- `registerShortcut()` handlers are typed to receive plain `ExtensionContext` in upstream [`types.ts:1010-1014`](/home/bitzaven/CodingProjects/CasparPI/source-code/pi-mono/packages/coding-agent/src/core/extensions/types.ts#L1010)
- interactive mode constructs a shortcut context without `switchSession()` in upstream [`interactive-mode.ts:1165-1193`](/home/bitzaven/CodingProjects/CasparPI/source-code/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1165)

So the current code typechecks only because the local shim incorrectly types shortcut handlers as `ExtensionCommandContext`. At runtime, `Ctrl+B` will call `ctx.switchSession` on an object that does not have that method.

### Repro

1. Open a thread session with a remembered parent.
2. Press `Ctrl+B`.
3. Observe a shortcut-handler failure instead of a session switch, or no successful navigation back to the parent session.

### Notes

`/subagents-back` can still work because commands do receive `ExtensionCommandContext`. The bug is specific to the shortcut path.
