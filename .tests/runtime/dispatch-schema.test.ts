import assert from "node:assert/strict";
import test from "node:test";

import { default as registerExtension } from "../../index";

type RegisteredTool = {
	name: string;
	parameters?: unknown;
};

function makeFakePi() {
	const tools = new Map<string, RegisteredTool>();

	return {
		on: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool(config: RegisteredTool) {
			tools.set(config.name, config);
		},
		getActiveTools: () => ["read", "write", "edit", "bash", "dispatch"],
		getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "dispatch" }],
		setActiveTools: () => {},
		tools,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object", "expected a schema object");
	assert.notEqual(value, null, "expected a schema object");
	assert.equal(Array.isArray(value), false, "expected a schema object");
	return value as Record<string, unknown>;
}

test("dispatch should register a host-valid schema that encodes single-vs-batch params", () => {
	const fakePi = makeFakePi();
	registerExtension(fakePi as any);

	const dispatch = fakePi.tools.get("dispatch");
	assert.ok(dispatch, "dispatch tool should be registered");

	const parameters = asRecord(dispatch.parameters);

	assert.equal(
		parameters.type,
		"object",
		"dispatch.parameters should be a host-consumable object schema, not an internal shim wrapper",
	);

	const properties = asRecord(parameters.properties);
	assert.equal(asRecord(properties.thread).type, "string");
	assert.equal(asRecord(properties.action).type, "string");
	assert.equal(asRecord(properties.tasks).type, "array");
	assert.equal("oneOf" in parameters, false, "dispatch schema must not use top-level oneOf because the host rejects it");
	assert.equal("anyOf" in parameters, false, "dispatch schema must not use top-level anyOf because the host rejects it");
	assert.equal("allOf" in parameters, false, "dispatch schema must not use top-level allOf because the host rejects it");
	assert.equal("enum" in parameters, false, "dispatch schema must not use top-level enum because the host rejects it");
	assert.equal("not" in parameters, false, "dispatch schema must not use top-level not because the host rejects it");
});

test("dispatch should keep single-vs-batch validation in execute when schema combinators are unavailable", async () => {
	const fakePi = makeFakePi();
	registerExtension(fakePi as any);

	const dispatch = fakePi.tools.get("dispatch") as RegisteredTool & {
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
			ctx: Record<string, unknown>,
		) => Promise<unknown>;
	};
	assert.ok(dispatch, "dispatch tool should be registered");

	const result = await dispatch.execute(
		"tool-call-invalid",
		{},
		undefined,
		undefined,
		{
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: () => {} },
			sessionManager: {
				getSessionFile: () => undefined,
				getBranch: () => [],
			},
			model: { provider: "openai-codex", id: "gpt-5.4" },
		} as any,
	) as { isError?: boolean; content?: Array<{ text?: string }> };

	assert.equal(result.isError, true);
	assert.match(result.content?.[0]?.text ?? "", /Provide either thread\+action \(single\) or tasks array \(batch\)\./);
});
