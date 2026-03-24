import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { default as registerExtension } from "../../index";

type RegisteredCommand = {
	handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

type RegisteredEventHandler = (event: unknown, ctx: Record<string, unknown>) => Promise<unknown> | unknown;

function makeTempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-model-sub-prompt-"));
}

function makeFakePi() {
	const commands = new Map<string, RegisteredCommand>();
	const events = new Map<string, RegisteredEventHandler[]>();

	return {
		on(event: string, listener: RegisteredEventHandler) {
			const handlers = events.get(event) ?? [];
			handlers.push(listener);
			events.set(event, handlers);
		},
		registerCommand(name: string, config: RegisteredCommand) {
			commands.set(name, config);
		},
		registerShortcut: () => {},
		registerTool: () => {},
		getActiveTools: () => ["read", "write", "edit", "bash", "dispatch"],
		getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "dispatch" }],
		setActiveTools: () => {},
		commands,
		events,
	};
}

function writeParentSession(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, '{"type":"session"}\n', "utf8");
}

function writeThreadsState(cwd: string, enabled: boolean): void {
	const statePath = path.join(cwd, ".pi", "threads", "state.json");
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	fs.writeFileSync(statePath, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

test("before_agent_start should describe on-disk worker sessions precisely instead of claiming they are active", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const threadSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");

	try {
		writeParentSession(parentSession);
		writeThreadsState(projectDir, true);
		fs.mkdirSync(path.dirname(threadSession), { recursive: true });
		fs.writeFileSync(threadSession, '{"type":"session"}\n', "utf8");

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const beforeAgentStartHandlers = fakePi.events.get("before_agent_start") ?? [];
		assert.equal(beforeAgentStartHandlers.length > 0, true, "before_agent_start handler should be registered");

		const promptResult = await beforeAgentStartHandlers[0](
			{ systemPrompt: "BASE SYSTEM PROMPT\n" },
			{
				cwd: projectDir,
				hasUI: true,
				ui: {
					notify: () => {},
				},
				sessionManager: {
					getSessionFile: () => parentSession,
					getBranch: () => [],
				},
				model: { provider: "openai-codex", id: "gpt-5.4" },
			} as any,
		) as { systemPrompt?: string } | undefined;

		assert.equal(typeof promptResult?.systemPrompt, "string");
		assert.match(promptResult!.systemPrompt!, /Known Worker Sessions on Disk/);
		assert.match(promptResult!.systemPrompt!, /not necessarily running right now/i);
		assert.doesNotMatch(promptResult!.systemPrompt!, /## Active Threads/);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});

test("before_agent_start should expose the active subagent model metadata after /model-sub override", async () => {
	const projectDir = makeTempProject();
	const parentSession = path.join(projectDir, ".pi", "sessions", "parent.jsonl");
	const parentModel = { provider: "openai-codex", id: "gpt-5.4" };
	const overrideModel = "google/gemini-2.5-flash";

	try {
		writeParentSession(parentSession);
		writeThreadsState(projectDir, true);

		const fakePi = makeFakePi();
		registerExtension(fakePi as any);

		const modelSub = fakePi.commands.get("model-sub");
		const beforeAgentStartHandlers = fakePi.events.get("before_agent_start") ?? [];
		assert.ok(modelSub, "/model-sub should be registered");
		assert.equal(beforeAgentStartHandlers.length > 0, true, "before_agent_start handler should be registered");

		await modelSub!.handler(overrideModel, {
			cwd: projectDir,
			hasUI: true,
			ui: {
				notify: () => {},
			},
			sessionManager: {
				getSessionFile: () => parentSession,
				getBranch: () => [],
			},
		} as any);

		const promptResult = await beforeAgentStartHandlers[0](
			{ systemPrompt: "BASE SYSTEM PROMPT\n" },
			{
				cwd: projectDir,
				hasUI: true,
				ui: {
					notify: () => {},
				},
				sessionManager: {
					getSessionFile: () => parentSession,
					getBranch: () => [],
				},
				model: parentModel,
			} as any,
		) as { systemPrompt?: string } | undefined;

		assert.equal(typeof promptResult?.systemPrompt, "string");
		assert.match(
			promptResult!.systemPrompt!,
			/(subagent|worker).*model/i,
			"the orchestrator prompt should describe the currently selected subagent model after override",
		);
		assert.match(
			promptResult!.systemPrompt!,
			/google\/gemini-2\.5-flash/,
			"the orchestrator prompt metadata should surface the overridden provider/model",
		);
	} finally {
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
