import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PiActorRuntime } from "../../src/runtime/pi-actor";

type RegisteredTool = {
	name: string;
	execute?: (...args: any[]) => Promise<unknown> | unknown;
	renderResult?: (...args: any[]) => unknown;
};

type RegisteredCommand = {
	handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

type RegisteredShortcut = {
	description?: string;
	handler: (ctx: Record<string, unknown>) => Promise<void> | void;
};

type RegisteredEventHandler = (event: unknown, ctx: Record<string, unknown>) => Promise<unknown> | unknown;

export type BrowserLike = {
	handleInput(input: string): void;
	render(width: number): string[];
	invalidate(): void;
};

export function makeTempProject(prefix = "pi-threads-subagent-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeFakePi() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts = new Map<string, RegisteredShortcut>();
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
		registerShortcut(name: string, config: RegisteredShortcut) {
			shortcuts.set(name, config);
		},
		registerTool(config: RegisteredTool) {
			tools.set(config.name, config);
		},
		getActiveTools: () => ["read", "write", "edit", "bash", "dispatch"],
		getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "dispatch" }],
		setActiveTools: () => {},
		tools,
		commands,
		shortcuts,
		events,
	};
}

export function makeTheme() {
	return {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};
}

export function makeSelectKeybindings(bindings: Partial<Record<"tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", string>> = {}) {
	const defaults = {
		"tui.select.up": "UP",
		"tui.select.down": "DOWN",
		"tui.select.confirm": "ENTER",
		"tui.select.cancel": "ESC",
	};

	return {
		matches(input: string, command: keyof typeof defaults) {
			return input === (bindings[command] ?? defaults[command]);
		},
	};
}

export function writeThreadSession(filePath: string, lines: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
		"utf8",
	);
}

export function createBrowserPromise(
	factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
): { browser: BrowserLike; result: Promise<unknown> } {
	let browser!: BrowserLike;
	const result = new Promise<unknown>((resolve) => {
		browser = factory(
			{ terminal: { rows: 24 } },
			makeTheme(),
			makeSelectKeybindings(),
			resolve,
		) as BrowserLike;
	});

	return { browser, result };
}

export function makeCommandContext(params: {
	cwd: string;
	sessionFile: string;
	branch?: unknown[];
	ui?: Record<string, unknown>;
	hasUI?: boolean;
	switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	model?: { provider: string; id: string };
}) {
	return {
		cwd: params.cwd,
		hasUI: params.hasUI ?? true,
		ui: {
			notify: () => {},
			...params.ui,
		},
		sessionManager: {
			getSessionFile: () => params.sessionFile,
			getBranch: () => params.branch ?? [],
		},
		...(params.switchSession ? { switchSession: params.switchSession } : {}),
		...(params.model ? { model: params.model } : {}),
	};
}

export function patchPiActorInvoke(implementation: typeof PiActorRuntime.prototype.invoke): () => void {
	const original = PiActorRuntime.prototype.invoke;
	PiActorRuntime.prototype.invoke = implementation;
	return () => {
		PiActorRuntime.prototype.invoke = original;
	};
}
