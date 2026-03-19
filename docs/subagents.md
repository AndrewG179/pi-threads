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

## `/subagents`

`/subagents` opens an interactive selector overlay that lists known thread sessions from `.pi/threads/*.jsonl`.

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

Once opened, the subagent is just a **normal pi chat session**. The only extra UI is a small banner that says it is a subagent session and shows the remembered parent session.

While inside a subagent session:
- `Ctrl+B` should return to the remembered parent session
- `/subagents-back` should also return to the remembered parent session
- `/subagents` can be used again to jump to another subagent

Returning to the parent restores the parent chat session rather than opening a copy.
