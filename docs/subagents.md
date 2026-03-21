# Thread orchestrator behavior (current implementation)

This document describes the **currently implemented** behavior in this package.

> Canonical source of truth: runtime code in `index.ts` and `src/backends/pi-run-backend.ts`.

## Scope

This extension currently provides a `dispatch` tool for thread-based execution.
It does **not** register slash commands such as `/threads on`, `/threads off`, or `/subagents`.

## Session startup behavior

On session start, the extension:

- reconstructs per-thread episode counters from prior `dispatch` tool results in branch history
- removes direct file/shell tools from the active tool set (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`)
- emits a UI notification that thread orchestrator mode is active

On each agent turn, it appends an orchestrator system prompt before execution.

## Thread persistence model

Thread sessions are persisted under:

- `.pi/threads/<sanitized-thread-name>.jsonl`

Thread names are sanitized by replacing non `[A-Za-z0-9_.-]` characters with `_` before generating the session filename.

## Dispatch execution model

`dispatch` accepts:

- single mode: `{ thread, action }`
- batch mode: `{ tasks: [{ thread, action }, ...] }`

Execution semantics:

- tasks in different threads can run concurrently
- runs for the same thread are serialized in order
- each successful run increments that thread's episode counter

## Episode summarization

Dispatch results are summarized into an episode composed of:

- tool call summaries
- tool result summaries
- assistant response text

This is designed to return high-signal execution context to the orchestrator without raw trace dumps.
