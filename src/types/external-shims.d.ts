declare module "@mariozechner/pi-agent-core" {
	export interface AgentToolResult<TDetails = unknown> {
		content: Array<{ type: string; text?: string; [key: string]: unknown }>;
		details?: TDetails;
		isError?: boolean;
	}
}

declare module "@mariozechner/pi-ai" {
	export type MessageContentPart =
		| { type: "text"; text: string }
		| { type: "toolCall"; name: string; arguments: Record<string, unknown>; id?: string; partialJson?: string };

	export interface Message {
		role: string;
		content: MessageContentPart[];
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
		model?: string;
		stopReason?: string;
		errorMessage?: string;
		toolName?: string;
		details?: unknown;
		isError?: boolean;
	}
}

declare module "@mariozechner/pi-coding-agent" {
	interface ToolDefinition {
		name: string;
	}

	interface SessionEntry {
		type: string;
		id?: string;
		parentId?: string | null;
		message: {
			role: string;
			toolName?: string;
			details?: unknown;
			content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
		};
	}

	interface SessionManager {
		getBranch(): SessionEntry[];
		getSessionFile(): string | undefined;
	}

	interface UIApi {
		notify(message: string, level?: string): void;
		setStatus(key: string, text: string | undefined): void;
		setWidget(key: string, content: unknown, options?: unknown): void;
		custom<T>(
			factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
			options?: unknown,
		): Promise<T>;
		theme: any;
	}

	interface ToolExecuteContext {
		cwd: string;
		hasUI: boolean;
		ui: UIApi;
		sessionManager: SessionManager;
		model?: {
			provider: string;
			id: string;
		};
	}

	interface ExtensionContext extends ToolExecuteContext {}

	interface ExtensionCommandContext extends ExtensionContext {
		switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	}

	interface DispatchToolParams {
		thread?: string;
		action?: string;
		tasks?: Array<{ thread: string; action: string }>;
		[key: string]: unknown;
	}

	interface ToolDefinitionConfig {
		name: string;
		label?: string;
		description?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters?: unknown;
		execute?: (
			toolCallId: string,
			params: DispatchToolParams,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: any) => void) | undefined,
			ctx: ToolExecuteContext,
		) => Promise<any>;
		renderCall?: (args: DispatchToolParams, theme: any) => any;
		renderResult?: (result: any, controls: any, theme: any) => any;
	}

	export interface ExtensionAPI {
		on(event: string, listener: (event: any, ctx: any) => any): void;
		registerCommand(
			name: string,
			config: {
				description?: string;
				getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
			},
		): void;
		registerShortcut(
			shortcut: string,
			config: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void },
		): void;
		getActiveTools(): string[];
		getAllTools(): ToolDefinition[];
		setActiveTools(toolNames: string[]): void;
		registerTool(config: ToolDefinitionConfig): void;
	}

	export function getMarkdownTheme(): any;
}

declare module "@mariozechner/pi-tui" {
	export interface KeybindingMatcher {
		matches(input: string, command: string): boolean;
	}

	export interface Renderable {
		render(width: number): string[];
		invalidate(): void;
	}

	export class Container implements Renderable {
		constructor();
		addChild(child: any): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export class Text implements Renderable {
		constructor(text: string, x: number, y: number);
		render(width: number): string[];
		invalidate(): void;
	}

	export class Markdown implements Renderable {
		constructor(markdown: string, x: number, y: number, theme: any);
		render(width: number): string[];
		invalidate(): void;
	}

	export class Spacer implements Renderable {
		constructor(lines: number);
		render(width: number): string[];
		invalidate(): void;
	}

	export function getEditorKeybindings(): KeybindingMatcher;
	export function truncateToWidth(input: string, width: number): string;
	export function visibleWidth(input: string): number;
}

declare module "@sinclair/typebox" {
	export const Type: {
		Object(schema: Record<string, unknown>, options?: Record<string, unknown>): unknown;
		Optional(schema: unknown): unknown;
		String(options?: Record<string, unknown>): unknown;
		Array(schema: unknown, options?: Record<string, unknown>): unknown;
	};
}
