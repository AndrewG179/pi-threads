# `/subagents` Over-Includes Historical Threads

Date: 2026-03-23
Git version: `418adae` (`refactor: reduce dispatch and metadata branches`)

## BR-008: `/subagents` lists every thread file in `.pi/threads` instead of only the current conversation

### Expected

`/subagents` should show only the thread sessions that belong to the current conversation or parent session. Historical thread files from other conversations should not appear.

### Actual

`collectSubagentCards()` scans every `.pi/threads/*.jsonl` file under the project at [src/subagents/metadata.ts](../src/subagents/metadata.ts), then returns a card for each file. The current parent session only affects metadata merging, not inclusion.

That means any old thread file left in `.pi/threads` appears in `/subagents`, even if it was created from a different parent session and is unrelated to the current conversation.

Concrete current-code path:

- `/subagents` computes the current conversation branch in [index.ts#L660](/home/bitzaven/CodingProjects/pi-threads/index.ts#L660) through [index.ts#L664](/home/bitzaven/CodingProjects/pi-threads/index.ts#L664)
- it then calls [`collectSubagentCards(ctx.cwd, parentEntries)`](../index.ts)
- [`collectSubagentCards`](../src/subagents/metadata.ts) builds the base card set by scanning every `*.jsonl` under `.pi/threads` at [src/subagents/metadata.ts#L231](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L231) through [src/subagents/metadata.ts#L237](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L237)
- only after that does it merge current-parent dispatch details at [src/subagents/metadata.ts#L240](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts#L240)

So `parentEntries` decorates cards; it does not filter them.

### Repro

1. Create a project with two thread session files under `.pi/threads`.
2. Mark only one of them as belonging to the current parent session.
3. Open `/subagents`.
4. Observe that both the current thread and the unrelated historical thread are listed.

### Impact

The selector shows stale or unrelated thread entries, which makes `/subagents` noisy and misleading. The user expectation is conversation-local thread navigation, not a dump of every historical thread file in the project.

This is especially bad in this repo because the working tree currently has many stale thread transcripts on disk, including:

- [`.pi/threads/git-branching.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/git-branching.jsonl)
- [`.pi/threads/issue-scan.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/issue-scan.jsonl)
- [`.pi/threads/pi-loading.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/pi-loading.jsonl)
- [`.pi/threads/refactor-actor.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/refactor-actor.jsonl)
- [`.pi/threads/refactor-core.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/refactor-core.jsonl)
- [`.pi/threads/refactor-integration.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/refactor-integration.jsonl)
- [`.pi/threads/refactor-tests.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/refactor-tests.jsonl)
- [`.pi/threads/repo-survey.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/repo-survey.jsonl)
- [`.pi/threads/repro-harness.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/repro-harness.jsonl)
- [`.pi/threads/repro-tests.jsonl`](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/repro-tests.jsonl)

### Evidence

- Failing reproducer was added at [metadata.test.ts#L240](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/metadata.test.ts#L240) through [metadata.test.ts#L285](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/metadata.test.ts#L285).
- Running `./node_modules/.bin/tsx --test .tests/subagents/metadata.test.ts` currently fails with `2 !== 1`, because `collectSubagentCards` returns both the current thread and the unrelated historical thread.
- Local `.pi/threads/state.json` currently has no usable `parentBySession` mapping in [state.json](/home/bitzaven/CodingProjects/pi-threads/.pi/threads/state.json), so current-disk state cannot be used as the primary inclusion filter here.

### Intended Source Of Truth

The safest inclusion source is the current parent conversation branch that `/subagents` already has in hand:

- [`ctx.sessionManager.getBranch()`](../index.ts) for the current parent session, or
- [`loadSessionBranchFromFile(...)`](../src/subagents/metadata.ts) when viewing a subagent and reopening its remembered parent.

That branch contains the `dispatch` tool results for this conversation. Those dispatch items are the authoritative list of threads this conversation created or used.

### Safest Fix Shape

1. Start from the current parent branch's `dispatch` items, not a filesystem-wide scan.
2. For each referenced thread, include it only if the real session file exists under `.pi/threads`.
3. Then enrich those filtered cards from the session transcript and current-parent dispatch details.
4. `parentBySession` may still be used as supplemental persistence or consistency data, but should not be the primary inclusion source for `/subagents`.

### Current State For Handoff

- Bug report written
- Failing reproducer written
- No source fix committed yet
- An implementation worker was spawned after the failing test, but no visible source edits had landed at the time this handoff note was written
