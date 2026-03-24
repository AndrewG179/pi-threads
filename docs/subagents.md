# `/subagents` behavior

This extension adds these user-facing controls:

- `/threads on`
- `/threads off`
- `/subagents`
- `/model-sub`

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
That file is only for thread mode enablement; it does not persist parent/subagent navigation relationships or the `/model-sub` override.

## `/model-sub`

Worker model selection is separate from thread mode and separate from `/subagents` view state.

Branch-canonical default:
- dispatched workers inherit the current parent session model unless an explicit `/model-sub` override is set
- if the parent model is not available in extension context, the extension still treats the mode as inheritance rather than falling back to a documented fixed default

Selection modes:
- `/model-sub provider/model` sets an explicit worker-model override directly
- `/model-sub <query>` fuzzy-matches against configured available models; if exactly one model matches, that match becomes the override
- in the interactive UI, ambiguous or partial input falls through to a picker with the search pre-filled

Picker behavior:
- the picker shows models currently available from the host model registry
- the picker includes an explicit inherit/current-session option, which clears the override instead of selecting a fixed model
- the picker is the canonical interactive way to browse and select a subagent model override

Clearing/resetting the override:
- `/model-sub inherit` clears the explicit override and returns workers to parent-model inheritance
- `/model-sub clear`, `/model-sub default`, `/model-sub none`, and `/model-sub reset` are equivalent reset commands

Status-bar display:
- when an explicit override is active, the status bar shows `sub: override provider/model`
- when no override is active and the parent model is known, the status bar shows `sub: inherit provider/model`
- when no override is active and the parent model is not available in context, the status bar shows `sub: inherit current session model`

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

Browser detail behavior:
- the browser remains summary-oriented
- the selected detail pane may show more wrapped `Action` and `Output` than the compact session list, but it is still a bounded summary view
- browser `Recent Tool` remains a short preview, not a full transcript/tool log

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

Inspector behavior:
- the inspector is a scrollable detail view inside the same custom view
- `Up` and `Down` scroll the inspector body
- the inspector should show the full task/action text currently recorded for that subagent
- the inspector should show the full output history currently recorded for that subagent in the extension-owned run data, not just the tail preview used in the browser
- the inspector is still based on extension-owned subagent detail data; it is not a host-native transcript/chat mount

## Non-negotiable invariants

- Background execution is independent of the active view.
- The browser is live and streaming.
- The browser must not hide running children until completion.
- Navigation must not be implemented by preemptively blocking or cancelling healthy background work.
- UI state and execution state are separate concerns.
- Live discovery comes from the runtime-owned store, not transcript scanning or persisted parent linkage.
