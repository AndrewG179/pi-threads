# `/subagents` behavior

This extension adds two user-facing controls:

- `/threads on`
- `/threads off`
- `/subagents`

## Thread mode

Thread mode is **off by default**.

When thread mode is **on** in a non-thread session:
- the session behaves like the orchestrator session
- the orchestrator system prompt is appended before agent turns
- the `dispatch` tool is available
- direct file/shell tools are removed from the active tool set

When thread mode is **off**:
- the orchestrator system prompt is not appended
- the `dispatch` tool is not active
- the session behaves like a normal pi session

The on/off state is stored per-project in `.pi/threads/state.json`.
That file is only for thread mode enablement; it does not persist parent/subagent navigation relationships.

## `/subagents`

`/subagents` opens the subagent browser for the current parent context.

The browser is a live view, not a static snapshot.

The browser must show subagents for the current parent session while they are still running:
- newly spawned/in-flight subagents must appear before the parent `dispatch` finishes
- card contents should update as new information arrives
- the browser must not require the user to close and reopen it to discover new children or refreshed status

The browser is scoped to the current session context:
- show only subagents belonging to the current session's runtime-owned run store
- include completed subagents already recorded in the current session's `dispatch` toolResults
- do not mix in historical or unrelated thread sessions from other sessions just because files exist on disk

Thread `.jsonl` files are durable history for the worker sessions themselves. They are not the canonical source of live parent/child relationships.

The browser should show a compact card per subagent with the information this extension actually has:
- subagent/thread name
- latest task/action
- latest agent output preview
- recent tool-call preview
- accumulated cost seen in the current parent session
- completion status (`Done`, `Escalated`, `Aborted`, or unknown)

This is a view concern only. Whether the user is currently looking at the parent, a subagent, or the browser must not change whether work continues.

Keyboard behavior:
- arrow keys move selection
- `Enter` opens the selected subagent inspector inside the same custom view
- `Esc` backs out of the inspector, then closes the browser

## Opening a subagent

Inspecting a subagent changes what the user is looking at. It must not pause, kill, or block ongoing work in the parent or in any other subagent.

Required runtime behavior:
- the parent session keeps running even if the user opens `/subagents`
- the parent session keeps running even if the user opens a subagent inspector
- subagents keep running even if the user leaves the inspector
- main and subagent work continues regardless of which session/view the user is currently looking at
- switching views is a UI/navigation action, not an execution-control action

The browser and inspector are same-session view state over the extension-owned background run store. They must not call host `switchSession(...)` for in-flight inspection, and they must not depend on remembered-parent banner/back-navigation machinery.

## Non-negotiable invariants

- Background execution is independent of the active view.
- The browser is live and streaming.
- The browser must not hide running children until completion.
- Navigation must not be implemented by preemptively blocking or cancelling healthy background work.
- UI state and execution state are separate concerns.
- Live discovery comes from the runtime-owned store, not transcript scanning or persisted parent linkage.
