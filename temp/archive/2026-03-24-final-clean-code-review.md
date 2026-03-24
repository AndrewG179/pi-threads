# Final Clean-Code Review
Date: 2026-03-24 UTC
Branch: `refactor/explicit-run-state-machine`
HEAD: `d7e3fa8656ee8f33ad9a9321059b6be59a925cf5`

## Verdict
- Merge-ready: no

## Blocking finding
1. The branch still carries an active runtime blocker outside the cosmetic scope of this review: the live dispatch summary can still overrun terminal width and crash the parent TUI on current branch history.
   - Evidence: [bug-reports/2026-03-24-074050d-live-dispatch-summary-width-crash-on-return-to-parent.md](/home/bitzaven/CodingProjects/pi-threads/bug-reports/2026-03-24-074050d-live-dispatch-summary-width-crash-on-return-to-parent.md)
   - Why I still count it at current `HEAD`: the current head commit only touches [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts), [src/subagents/runtime-store.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/runtime-store.ts), [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts), and tests. The parent live-dispatch render path in [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L227) and [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L263) is unchanged, so the documented blocker is still unresolved by this head.

## Non-blocking cleanup suggestions
1. Split [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts) by responsibility.
   - At 1057 LOC, it is still the branch's main cleanliness problem. It mixes prompt/schema constants, dispatch rendering, session-mode sync, `/subagents`, `/model-sub`, and tool registration in one file.
   - The highest-value extractions are the dispatch UI/rendering block around [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L227), the subagent browser/model-picker commands around [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L404), and the session-mode/status helpers around [index.ts](/home/bitzaven/CodingProjects/pi-threads/index.ts#L293).
   - This is the biggest LOC-reduction and readability win available without changing behavior.

2. Simplify the `SubagentBrowser` layout code in [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts).
   - The current implementation is serviceable, but it does a lot of work for a small UI: line-budget allocation at [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L51), browser/inspector dual rendering at [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L183), and multiple width/height/frame helpers at [src/subagents/view.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/view.ts#L35).
   - The code reads more clever than necessary. A simpler explicit section renderer would likely cut LOC and make the UI easier to reason about.

3. Trim test-scaffolding bulk in [.tests/subagents/view-model-contract.test.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/view-model-contract.test.ts).
   - At 1176 LOC, this file now reads like several suites stapled together. The repeated inline fixtures and renderer plumbing near [view-model-contract.test.ts](/home/bitzaven/CodingProjects/pi-threads/.tests/subagents/view-model-contract.test.ts#L25) and throughout the file make intent harder to scan than it needs to be.
   - This is not a correctness problem, but it is a maintenance smell. A few shared builders for dispatch results, browser mounts, and fake command contexts would cut noise meaningfully.

## Minor notes
- [src/subagents/runtime-store.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/runtime-store.ts) is mostly coherent, but it still has some avoidable ceremony: normalized-parent/session lookup is repeated across [src/subagents/runtime-store.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/runtime-store.ts#L102), [src/subagents/runtime-store.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/runtime-store.ts#L114), [src/subagents/runtime-store.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/runtime-store.ts#L126), and [src/subagents/runtime-store.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/runtime-store.ts#L243). It is clean enough to merge once the blocker above is gone, but there is easy LOC to remove later.
- [src/subagents/metadata.ts](/home/bitzaven/CodingProjects/pi-threads/src/subagents/metadata.ts) is the cleanest part of the current subagent surface. I would preserve its current level of directness instead of abstracting it further.
