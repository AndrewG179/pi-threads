import * as os from "node:os";

import type { Message } from "@mariozechner/pi-ai";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

import type { DispatchDetails, DisplayItem, SingleDispatchResult } from "./types.ts";
import {
	formatTokens,
	formatUsage,
	renderColumnsInRows,
	truncateToWidth,
	wrapText,
} from "./helpers.ts";

interface ThemeArg {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: string, text: string) => string,
): string {
	const shorten = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (toolName) {
		case "bash": {
			const cmd = ((args.command as string) || "...").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
			const preview = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
			return fg("muted", "$ ") + fg("toolOutput", preview);
		}
		case "read": {
			const filePath = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "read ") + fg("accent", filePath);
		}
		case "write": {
			const filePath = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "write ") + fg("accent", filePath);
		}
		case "edit": {
			const filePath = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "edit ") + fg("accent", filePath);
		}
		default: {
			const s = JSON.stringify(args);
			return fg("accent", toolName) + fg("dim", ` ${s.length > 60 ? s.slice(0, 60) + "..." : s}`);
		}
	}
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

// ─── renderCall ───

export function renderCall(args: Record<string, unknown>, theme: ThemeArg) {
	const tasks = Array.isArray(args.tasks) ? args.tasks as Array<{ thread: string; action: string }> : [];
	if (tasks.length > 0) {
		return {
			render(width: number): string[] {
				return renderColumnsInRows(
					tasks.map((t: { thread: string; action: string }) => (colWidth: number) => {
						const header = theme.fg("accent", theme.bold(`[${t.thread}]`));
						const actionLines = wrapText(t.action, colWidth - 1);
						return [header, ...actionLines.map((l: string) => theme.fg("dim", l))];
					}),
					width,
					theme,
				);
			},
			invalidate(): void {},
		};
	}

	// Single dispatch
	const threadName = (args.thread as string) || "...";
	const actionText = (args.action as string) || "...";

	return {
		render(width: number): string[] {
			const header = theme.fg("toolTitle", theme.bold("dispatch ")) + theme.fg("accent", theme.bold(`[${threadName}]`));
			const actionLines = wrapText(actionText, width - 2);
			return [header, ...actionLines.map((l: string) => "  " + theme.fg("dim", l))];
		},
		invalidate(): void {},
	};
}

// ─── renderResult ───

export function renderResult(result: { details?: DispatchDetails; content: Array<{ type: string; text?: string }> }, { expanded }: { expanded: boolean }, theme: ThemeArg) {
	const details = result.details as DispatchDetails | undefined;

	if (!details || details.items.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" && text.text ? text.text : "(no output)", 0, 0);
	}

	const renderSingleItem = (item: SingleDispatchResult, isExpanded: boolean) => {
		const r = item.result;
		const isRunning = !item.episode || item.episode === "(running...)";
		const isError = !isRunning && (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted");
		const threadLabel = theme.fg("accent", theme.bold(`[${item.thread}]`));
		const epLabel = theme.fg("muted", `ep${item.episodeNumber}`);
		const modelLabel = r.model ? theme.fg("dim", r.model) : "";

		// ── Running state: action + live tool calls + stats ──
		if (isRunning) {
			return {
				render(colWidth: number): string[] {
					const lines: string[] = [];

					// Status line: ⏳ turns · cost · context
					const statParts: string[] = [];
					if (r.usage.turns) statParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
					if (r.usage.cost) statParts.push(`$${r.usage.cost.toFixed(2)}`);
					if (r.usage.contextTokens > 0) statParts.push(`ctx:${formatTokens(r.usage.contextTokens)}`);
					if (statParts.length > 0) {
						lines.push(theme.fg("warning", "⏳") + " " + theme.fg("dim", statParts.join(" · ")));
					}

					// Live tool calls
					const displayItems = getDisplayItems(r.messages);
					const toolCalls = displayItems.filter(
						(i): i is Extract<DisplayItem, { type: "toolCall" }> => i.type === "toolCall",
					);
					for (const tc of toolCalls) {
						lines.push(theme.fg("muted", "→ ") + formatToolCall(tc.name, tc.args, theme.fg.bind(theme)));
					}

					return lines.map((l) => truncateToWidth(l, colWidth));
				},
				invalidate(): void {},
			};
		}

		// ── Done state: episode ──
		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const newBadge = r.isNewThread ? theme.fg("warning", " new") : "";

		if (isExpanded) {
			const mdTheme = getMarkdownTheme();
			const container = new Container();
			container.addChild(new Text(`${icon} ${threadLabel} ${epLabel} ${modelLabel}${newBadge}`, 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Action ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", item.action), 0, 0));

			const displayItems = getDisplayItems(r.messages);
			const toolCalls = displayItems.filter(
				(i): i is Extract<DisplayItem, { type: "toolCall" }> => i.type === "toolCall",
			);
			if (toolCalls.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
				for (const tc of toolCalls) {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(tc.name, tc.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Episode ───"), 0, 0));
			container.addChild(new Markdown(item.episode.trim(), 0, 0, mdTheme));

			const usageStr = formatUsage(r.usage, r.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}

		// Collapsed done
		let text = `${icon} ${threadLabel} ${epLabel} ${modelLabel}${newBadge}`;
		if (isError && r.errorMessage) text += `\n${theme.fg("error", r.errorMessage)}`;
		text += `\n${item.episode}`;
		const usageStr = formatUsage(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	};

	// Single mode: render as before
	if (details.mode === "single" || details.items.length === 1) {
		const component = renderSingleItem(details.items[0], expanded);
		if (!expanded) {
			const container = new Container();
			container.addChild(component);
			container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			return container;
		}
		return component;
	}

	// Batch mode: render in rows of 3 columns
	return {
		render(width: number): string[] {
			const lines = renderColumnsInRows(
				details.items.map((item) => (colWidth: number) => {
					const component = renderSingleItem(item, expanded);
					return component.render(colWidth);
				}),
				width,
				theme,
			);
			if (!expanded) lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
			return lines;
		},
		invalidate(): void {},
	};
}
