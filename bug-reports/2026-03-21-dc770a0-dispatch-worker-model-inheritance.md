## BR-014: Dispatch workers do not actually inherit the parent model

### Expected

When the parent session is running on a specific model, dispatched worker sessions should launch on the same provider/model by default.

In a real run:

- parent session: `google/gemini-2.5-flash`
- worker session: should also be `google/gemini-2.5-flash`

### Actual

The worker session falls back to pi's default model instead of inheriting the parent model.

Observed on `dc770a0` in a throwaway project:

- parent session used `google/gemini-2.5-flash`
- worker session started with `openai-codex/gpt-5.3-codex`
- stderr included `Warning: No models match pattern "openai-codex/gpt-5.4"`

### Why this happens

The dispatch path currently derives a single string like `google/gemini-2.5-flash` and passes it through `PiActorRuntime`.

`PiActorRuntime` then builds worker CLI args as:

- `--model google/gemini-2.5-flash`

But the real pi CLI does not treat `--model provider/modelId` as a provider override. In practice it keeps the default provider/model selection and ignores the intended inheritance.

The equivalent working CLI invocation is:

- `--provider google --model gemini-2.5-flash`

### Reproduction

1. Create a fresh temp project with this extension loaded explicitly.
2. Run `/threads on`.
3. Run `dispatch [smoke-live] Respond with exactly: hello` from a parent session using `--provider google --model gemini-2.5-flash`.
4. Inspect `.pi/threads/smoke-live.jsonl`.

Observed transcript:

- parent session file records `provider:"google", modelId:"gemini-2.5-flash"`
- worker session file records `provider:"openai-codex", modelId:"gpt-5.3-codex"`

### Impact

This breaks the documented "inherit from parent" behavior and can silently route thread work to the wrong provider, wrong model, different cost profile, or different auth setup.
