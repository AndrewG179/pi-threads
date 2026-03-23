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

`/subagents` opens an interactive selector overlay for the current parent context.

The browser lists subagents known to the current parent session:
- completed `dispatch` records already present in the current parent branch
- in-flight subagents registered by the current runtime before a completed `toolResult` is written

Thread `.jsonl` files are used to summarize the selected subagent, but they are not the canonical source of parent/session relationships.

The selector should show a compact card per subagent with the information this extension actually has:
- subagent/thread name
- latest task/action
- latest agent output preview
- recent tool-call preview
- accumulated cost seen in the current parent session
- completion status (`Done`, `Escalated`, `Aborted`, or unknown)

Keyboard behavior:
- arrow keys move selection
- `Enter` opens the selected subagent session
- `Esc` closes the selector

## Opening a subagent

Opening a subagent switches the current pi session to that thread session file.

If the current runtime still owns an in-flight parent `dispatch`, that session switch is blocked with a warning. This is a safety guard only: the extension does not claim to keep that dispatch alive across session switches.

Once opened, the subagent is just a **normal pi chat session**. The only extra UI is a small banner that says it is a subagent session and shows the current-runtime parent when one is known.

While inside a subagent session:
- `Ctrl+B` should return to the parent session when that parent was established in the current runtime
- `/subagents-back` should also return to that current-runtime parent session
- `/subagents` can be used again to jump to another subagent

If that remembered parent still has an in-flight `dispatch` owned by the current runtime, leaving the subagent is also blocked with the same warning until the dispatch finishes.

Returning to the parent restores the parent chat session rather than opening a copy.

If a thread session is opened directly in a fresh runtime, there is no persisted remembered parent. In that case the session is still treated as a subagent by path, but back-navigation is unavailable until the thread is opened from a parent context in the current runtime.
