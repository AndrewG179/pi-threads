import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";

type RegisteredEventHandler = (event: unknown, ctx: Record<string, unknown>) => Promise<unknown> | unknown;

function makeTempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-tool-restore-"));
}

function writeThreadsState(cwd: string, enabled: boolean): void {
	const statePath = path.join(cwd, ".pi", "threads", "state.json");
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	fs.writeFileSync(
		statePath,
		JSON.stringify({ enabled, parentBySession: {} }, null, 2) + "\n",
		"utf8",
	);
}

test("leaving orchestrator mode restores the stale startup snapshot instead of the current tool set", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const allTools = [
		{ name: "read" },
		{ name: "write" },
		{ name: "edit" },
		{ name: "bash" },
		{ name: "dispatch" },
		{ name: "custom-startup" },
		{ name: "custom-live" },
	];
	let activeTools = ["read", "write", "edit", "bash", "dispatch", "custom-startup"];
	const setActiveToolsCalls: string[][] = [];
	const events = new Map<string, RegisteredEventHandler[]>();

	try {
		fs.mkdirSync(path.dirname(parentSession), { recursive: true });
		fs.writeFileSync(parentSession, "{\"type\":\"session\"}\n", "utf8");
		writeThreadsState(projectDir, true);

		registerExtension({
			on(event: string, listener: RegisteredEventHandler) {
				const handlers = events.get(event) ?? [];
				handlers.push(listener);
				events.set(event, handlers);
			},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerTool: () => {},
			getActiveTools: () => [...activeTools],
			getAllTools: () => allTools,
			setActiveTools(toolNames: string[]) {
				activeTools = [...toolNames];
				setActiveToolsCalls.push([...toolNames]);
			},
		} as any);

		const sessionStartHandlers = events.get("session_start") ?? [];
		const sessionSwitchHandlers = events.get("session_switch") ?? [];
		assert.equal(sessionStartHandlers.length > 0, true, "session_start handler should be registered");
		assert.equal(sessionSwitchHandlers.length > 0, true, "session_switch handler should be registered");

		const ctx = {
			cwd: projectDir,
			hasUI: true,
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: () => {},
				setWidget: () => {},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [],
			},
		};

		for (const handler of sessionStartHandlers) {
			await handler({}, ctx as any);
		}

		activeTools = ["read", "write", "edit", "bash", "custom-live"];
		writeThreadsState(projectDir, false);

		for (const handler of sessionSwitchHandlers) {
			await handler({}, ctx as any);
		}

		assert.deepEqual(
			setActiveToolsCalls.at(-1),
			["read", "write", "edit", "bash", "custom-live"],
			"expected leaving orchestrator mode to restore the current tool set, not the stale startup snapshot",
		);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
