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

	const oneOf = parameters.oneOf;
	assert.ok(Array.isArray(oneOf), "dispatch schema should encode the single-vs-batch choice with oneOf");
	assert.equal(oneOf.length, 2, "dispatch schema should have one single-dispatch branch and one batch-dispatch branch");
});
