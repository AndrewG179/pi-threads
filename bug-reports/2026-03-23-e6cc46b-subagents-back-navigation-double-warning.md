# `/subagents` Back Navigation Double-Fires And Warns Incorrectly

Date: 2026-03-23
Git version: `e6cc46b` (`fix: align selector with runtime keybindings`)

## Assumptions

- I assume the intended subagent UX is the one described in [ui-from-slate.txt](../ui-from-slate.txt): once you are inside a subagent, `ctrl-b` should return to the main thread cleanly when a remembered parent exists.
- I assume warnings should reflect actual user-actionable problems, not duplicated internal routing.
- I assume a thread with no remembered parent is a valid state that can happen for older threads, manually opened sessions, or incomplete persisted mappings.

## BR-010: `ctrl-b` can trigger two back-navigation paths and emit duplicate `No remembered parent session for this thread.` warnings

### Expected

- Back navigation should route through one path only.
- If the current thread has no remembered parent session, the UI should not double-warn.
- `/subagents` browsing should not surface spurious back-navigation warnings unrelated to the selector itself.

### Actual

The current implementation binds `ctrl-b` in two places:

- a raw terminal input listener rewrites `Ctrl+B` into `/subagents-back` at [index.ts#L530](/home/bitzaven/CodingProjects/pi-threads/index.ts#L530) through [index.ts#L533](/home/bitzaven/CodingProjects/pi-threads/index.ts#L533)
- a registered shortcut also calls the back-navigation path at [index.ts#L636](/home/bitzaven/CodingProjects/pi-threads/index.ts#L636) through [index.ts#L640](/home/bitzaven/CodingProjects/pi-threads/index.ts#L640)

Both routes lead to the same warning site in [`switchToRememberedParent()`](../index.ts):

- [index.ts#L560](/home/bitzaven/CodingProjects/pi-threads/index.ts#L560) through [index.ts#L565](/home/bitzaven/CodingProjects/pi-threads/index.ts#L565)

That function emits:

- `No remembered parent session for this thread.`

The remembered-parent check comes from [`deriveSessionBehavior()`](../src/subagents/mode.ts):

- [src/subagents/mode.ts#L34](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L34) through [src/subagents/mode.ts#L49](/home/bitzaven/CodingProjects/pi-threads/src/subagents/mode.ts#L49)

which only populates `behavior.parentSessionFile` from persisted state at:

- [src/subagents/state.ts#L23](/home/bitzaven/CodingProjects/pi-threads/src/subagents/state.ts#L23) through [src/subagents/state.ts#L45](/home/bitzaven/CodingProjects/pi-threads/src/subagents/state.ts#L45)

So when a subagent session has no `parentBySession` entry, both `ctrl-b` paths can converge on the same warning and the user sees it twice.

### Why This Is Misleading

The warning text suggests a single clean failure mode, but the current implementation can produce it twice for one keypress because the same intent is wired twice. That makes the UI look more broken than the underlying state actually is.

It is also easy to misattribute the problem to `/subagents`, even though the warning is not emitted from the `/subagents` command handler itself:

- `/subagents` handler: [index.ts#L643](/home/bitzaven/CodingProjects/pi-threads/index.ts#L643) through [index.ts#L679](/home/bitzaven/CodingProjects/pi-threads/index.ts#L679)

### Evidence

- Current code has two `ctrl-b` routes into the same back-navigation function.
- The exact warning string exists only once, inside `switchToRememberedParent()`, at [index.ts#L564](/home/bitzaven/CodingProjects/pi-threads/index.ts#L564).
- The subagent banner also advertises `Ctrl+B or /subagents-back to return` even when the remembered parent is missing, at [index.ts#L485](/home/bitzaven/CodingProjects/pi-threads/index.ts#L485) through [index.ts#L489](/home/bitzaven/CodingProjects/pi-threads/index.ts#L489).

### Impact

- Duplicate warnings for one action
- Confusing attribution of failure to `/subagents`
- Broken-feeling navigation when opening older or manually reached thread sessions
- Banner text promises a return path that may not exist

### Safest Fix Shape

1. Route `ctrl-b` through exactly one back-navigation path.
2. Do not advertise `ctrl-b` return in the subagent banner unless a remembered parent exists.
3. If a thread has no remembered parent, show at most one clear warning.
4. Keep `/subagents` browsing available even when current-thread back-navigation is unavailable.

### Notes For Testing

Useful reproducer cases:

1. subagent session with remembered parent: `ctrl-b` should switch once, with no duplicate handling
2. subagent session without remembered parent: one warning at most
3. `/subagents` open from a thread lacking remembered parent: selector should still open without unrelated back-navigation warnings
