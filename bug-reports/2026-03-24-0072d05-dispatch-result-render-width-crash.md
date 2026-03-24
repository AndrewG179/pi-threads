# 2026-03-24 dispatch result render-width crash at `0072d05`

Assumptions
- Scope is the pushed branch at commit `0072d05a668326f7a6f19100fd722227b96db7a0`.
- The installed runtime in this repro is the local `node_modules/@mariozechner/pi-tui/index.js`.
- The bug report is based on real crash and livedrive artifacts captured on 2026-03-24, not on mocks.

## Summary

Live `dispatch` result rendering can crash the host TUI when the extension sends a multiline dispatch summary through `Text`.

The current extension code builds dispatch summaries as a single string with embedded `\n` separators, then passes that string to `Text`. The installed `@mariozechner/pi-tui` runtime returns `[this.text]` from `Text.render()`, so embedded newlines are not split into separate terminal rows before width validation.

## Evidence

1. Real crash artifact: `/home/bitzaven/.pi/agent/pi-crash.log`
   - `Crash at 2026-03-24T21:47:16.634Z`
   - `Terminal width: 80`
   - `Line 44 visible width: 91`

2. Real livedrive artifact: `/tmp/final-livedrive-after-cleanup.txt`
   - Step 4 (`dispatch` to a live child) is marked `FAIL`.
   - The report attributes the failure to the parent TUI crashing while rendering the live dispatch summary.

3. Direct runtime proof from the installed TUI dependency: `/home/bitzaven/CodingProjects/pi-threads/node_modules/@mariozechner/pi-tui/index.js`
   - `Text.render()` returns `[this.text]`.

4. Extension render path at `0072d05`
   - `index.ts`: `summarizeDispatchItem(...)` joins the header, summary/action text, and usage with `"\n"`.
   - `index.ts`: `renderResult(...)` wraps the combined multiline string in `new Text(...)`.

## Why this crashes

- A running dispatch item is summarized as multiple logical lines: header, action/episode, and usage.
- Those lines are flattened into one string with embedded newlines.
- The installed `Text` component does not split that multiline payload during `render(width)`.
- The host therefore sees a single rendered row containing all logical lines, and its width check measures the combined visible width instead of per-line widths.

The crash log matches that shape exactly: the offending row contains the header, `sleep 8;echo Z`, and usage text in one unsplit render result.

## Expected behavior

The dispatch result path must emit rendered rows that already respect logical line boundaries. Embedded newlines in dispatch summaries must not remain inside a single host-visible rendered row.

## Repro shape

1. Start a real session with thread mode enabled.
2. Issue a live `dispatch` call that produces an in-flight summary.
3. Let the parent TUI render the running dispatch result.
4. Observe the host crash once the unsplit multiline summary is width-checked.

## Notes

- This report is limited to the crash proven above. It does not claim that every possible long single-line summary is already width-safe.
- The immediate fault is newline normalization at the text-render boundary used by dispatch-result rendering.
