Assumptions:
- The host error text is accurate and current as of 2026-03-24 UTC.
- The `dispatch` tool must register a top-level JSON-schema object without top-level `oneOf`/`anyOf`/`allOf`/`enum`/`not`.

# Bug

`dispatch` currently registers a top-level schema object that still contains `oneOf`, which the host rejects.

# Evidence

- Current branch `refactor/explicit-run-state-machine` at `9df0af5` defines `DISPATCH_TOOL_PARAMETERS` with a top-level `oneOf` in [index.ts](/tmp/pi-threads-schema-fix/index.ts).
- The existing contract test in [.tests/runtime/dispatch-schema.test.ts](/tmp/pi-threads-schema-fix/.tests/runtime/dispatch-schema.test.ts) explicitly asserts that `dispatch.parameters.oneOf` exists, so the test suite currently encodes the host-invalid shape.
- The reported runtime error is:

  `Invalid schema for function 'dispatch': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.`

# Intended behavior

- `dispatch.parameters` must remain a top-level object schema.
- The schema may expose `thread`, `action`, and `tasks` as optional properties.
- The single-vs-batch choice must be enforced in `execute`, not by a top-level schema combinator.

# Fix shape

1. Remove the top-level `oneOf` from `DISPATCH_TOOL_PARAMETERS`.
2. Keep the existing runtime validation in `execute`.
3. Replace the current contract test with a host-validity test:
   - top-level `type === "object"`
   - no top-level `oneOf`/`anyOf`/`allOf`/`enum`/`not`
   - runtime still rejects missing/partial params
