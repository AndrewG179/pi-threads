# Bug Reports

- Date (UTC): 2026-03-21
- Git revision: `60f61d2`
- Branch context: clean working tree at report creation

## BR-003: Thread mode is always on and leaks into subagent sessions

### Summary
The extension unconditionally enables orchestrator behavior on every session load, even though thread mode is documented as off by default and subagent sessions are supposed to behave like normal pi chats.

### User-visible symptom
- A normal session starts in dispatch-only mode without the user enabling `/threads on`
- Built-in file/shell tools are stripped from every session
- If a subagent session is opened directly, it still behaves like an orchestrator instead of a normal worker chat with a small banner

### Expected
- Thread mode defaults to off
- `/threads on` enables orchestrator behavior only for non-thread parent sessions
- Thread session files under `.pi/threads/*.jsonl` open as normal chats, with only subagent navigation/banner UI layered on top

### Actual
`index.ts` applies orchestrator tool filtering on `session_start` and appends the orchestrator system prompt in `before_agent_start` with no persisted mode check and no thread-session detection.

### Evidence
- `docs/subagents.md` says thread mode is off by default and only affects non-thread sessions
- `index.ts` strips built-in tools in `session_start`
- `index.ts` appends the orchestrator prompt in `before_agent_start`
- There is no `.pi/threads/state.json` helper or any current session classification

### Suspected root cause
The extension was built as a permanently-on orchestrator prototype and never introduced the documented mode gate or the distinction between parent sessions and thread session files.

### Minimal reproduction strategy
Load the extension in a normal session with no `.pi/threads/state.json`, then inspect behavior or active tools: the session is still dispatch-only. Open a `.pi/threads/*.jsonl` session and it still receives orchestrator behavior.

## BR-004: Subagent parent/session metadata is not persisted, so back-navigation cannot work reliably

### Summary
The documented subagent workflow requires remembering the parent session for each opened thread session, but the extension currently stores no such metadata anywhere.

### User-visible symptom
- `/subagents-back` and `Ctrl+B` cannot reliably restore the original parent session
- Opening one subagent from inside another has no way to preserve the original parent
- Restarting pi loses any implicit parent/subagent relationship entirely

### Expected
The extension should persist parent-session mappings per project in `.pi/threads/state.json` and use them whenever a thread session is opened.

### Actual
There is no state file implementation and no persisted mapping from thread session path to parent session path.

### Evidence
- `docs/subagents.md` explicitly requires per-project state in `.pi/threads/state.json`
- `docs/subagents.md` requires remembered-parent behavior for `Ctrl+B` and `/subagents-back`
- Current code contains no state helpers and no session mapping storage

### Suspected root cause
The prototype only tracked dispatch episodes in memory and never introduced a persistent state model for subagent navigation.

### Minimal reproduction strategy
Inspect the current extension state model and session hooks: there is nowhere to record a parent session when opening a thread file, so any back-navigation feature would be lossy or impossible across reloads.

## BR-005: The extension cannot currently reconstruct the `/subagents` card metadata described in the docs

### Summary
The documented selector needs action/output/tool previews plus current-parent cost and completion status, but the current code only lists thread names from `.pi/threads/*.jsonl`.

### User-visible symptom
- A naive `/subagents` implementation would only be able to show names
- Cost and completion status for the current parent session cannot be derived from the existing `listThreads()` helper
- Cards would have blank or inconsistent previews unless thread transcripts and parent dispatch results are parsed explicitly

### Expected
The extension should derive selector cards from two data sources:
- thread session transcripts in `.pi/threads/*.jsonl`
- dispatch tool results in the current parent session branch

### Actual
`listThreads()` returns names only, and there is no metadata parser or aggregator in the current codebase.

### Evidence
- `docs/subagents.md` lists required card fields
- `index.ts` only provides `listThreads()` and dispatch rendering helpers
- No helper scans thread session files or aggregates per-thread usage/status from dispatch tool results

### Suspected root cause
Dispatch rendering was implemented first, but the reusable metadata extraction layer needed for a persistent selector was never added.

### Minimal reproduction strategy
Compare `docs/subagents.md` with the current helpers in `index.ts`: the extension can enumerate thread filenames, but it has no mechanism to produce the rest of the required card data.
