# Bug Reports

- Date (UTC): 2026-03-21
- Git revision: `085eeeb`
- Branch context: current working tree has local uncommitted changes outside this report

## BR-001: Dispatch worker can hang forever after initial output

### Summary
`dispatch` can remain stuck in the running state even after the worker has produced visible output, because the runtime now spawns the worker with stdin left open.

### User-visible symptom
- Dispatch card stays at `starting...` / running forever
- Worker may emit an initial token or message but never settles
- No final episode is produced because the child process never exits

### Expected
A one-shot worker invocation should terminate once it has finished producing its response, and the dispatch card should flip from running to done/error.

### Actual
`runThreadAction()` waits on the supervised runtime result forever when the child process stays alive. The UI keeps showing the dispatch as running because the final result never arrives.

### Evidence
- Current spawn path opens stdin with `stdio: "pipe"` in `src/runtime/pi-actor.ts`
- Historical pre-refactor path launched the worker with stdin closed/ignored using `["ignore", "pipe", "pipe"]`
- `index.ts` only settles the dispatch after `handle.result` resolves; if the child never exits, the card never leaves the running state

### Suspected root cause
The refactor changed the worker spawn mode from non-interactive to interactive-by-default. If the `pi` worker treats stdin as a live input stream or waits for EOF, leaving stdin open keeps the process alive indefinitely.

### Minimal reproduction strategy
Use a dummy worker that writes one line to stdout and then blocks on stdin until EOF. Under the current runtime spawn behavior it will hang; if stdin is ignored or explicitly closed it exits immediately.

## BR-002: Worker command is hardcoded to `pi`

### Summary
The runtime assumes the worker executable is available as `pi` on `PATH`.

### User-visible symptom
- On hosts where `pi` is not on `PATH`, dispatch fails immediately before any session transcript is created
- The failure may be hard to understand from the collapsed UI because stderr is not shown there

### Expected
Worker command resolution should either inherit from the parent runtime/environment explicitly or be configurable.

### Actual
`PiActorRuntime` defaults to `pi` with no override wiring in this extension.

### Evidence
- `src/runtime/pi-actor.ts` defines `DEFAULT_PI_COMMAND = "pi"`
- In this shell, `pi` is not present on `PATH`

### Notes
This is a real bug, but it does not explain the specific “stuck running forever” symptom as well as BR-001. A missing binary should fail fast, not hang.
