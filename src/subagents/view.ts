import { truncateToWidth, visibleWidth } from "../pi/runtime-deps";

import type { SubagentCard } from "./metadata";
import { wrapText } from "../text/wrap";

type KeybindingMatcher = {
	matches(input: string, command: string): boolean;
};

type TuiLike = {
	terminal?: {
		rows?: number;
	};
	requestRender?(): void;
};

const WIDE_LAYOUT_MIN_WIDTH = 56;
const MIN_BROWSER_ROWS = 18;
const SESSION_CARD_ROWS = 2;
const EMPTY_SESSION = "No subagent runs in this session.";
const EMPTY_ACTION = "(no action)";
const EMPTY_OUTPUT = "(no output yet)";
const EMPTY_TOOL = "(no recent tool calls)";
const BROWSER_ACTION_PREVIEW_LINES = 2;
const BROWSER_OUTPUT_PREVIEW_LINES = 2;
const BROWSER_TOOL_PREVIEW_LINES = 1;

function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function formatStatus(status: SubagentCard["status"]): string {
	return status === "done" ? "Done" : status === "escalated" ? "Escalated" : status === "aborted" ? "Aborted" : "Unknown";
}

function pad(input: string, width: number): string {
	const clipped = truncateToWidth(input, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function frame(lines: string[], width: number, height: number): string[] {
	const filled = lines.slice(0, height);
	while (filled.length < height) filled.push("");
	return filled.map((line) => pad(line, width));
}

function wrapLines(text: string, width: number, maxLines: number, fallback = "(none)"): string[] {
	const wrapped = wrapText(text || fallback, Math.max(12, width), { minWidth: 12 });
	return Number.isFinite(maxLines) ? wrapped.slice(0, maxLines) : wrapped;
}

function highlight(_theme: any, line: string, _selected: boolean, width: number): string {
	return pad(line, width);
}

function headerLine(card: SubagentCard, _theme: any, selected = false, title = `[${card.thread}]`): string {
	const prefix = selected ? "> " : "";
	return `${prefix}${title} ${formatStatus(card.status)} ${formatCost(card.accumulatedCost)}`;
}

export class SubagentBrowser {
	private selectedIndex = 0;
	private mode: "browser" | "inspector" = "browser";
	private inspectorScroll = 0;

	constructor(
		private readonly getCards: () => SubagentCard[],
		private readonly tui: TuiLike | undefined,
		private readonly theme: any,
		private readonly keybindings: KeybindingMatcher | undefined,
		private readonly done: (result: void | undefined) => void,
	) {}

	private requestRender(): void {
		this.tui?.requestRender?.();
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (!kb) return;
		const cards = this.cards();
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.mode === "inspector") {
				this.mode = "browser";
				this.inspectorScroll = 0;
				this.requestRender();
			}
			else this.done(undefined);
			return;
		}
		if (this.mode === "inspector") {
			if (kb.matches(keyData, "tui.select.up")) {
				this.inspectorScroll = Math.max(0, this.inspectorScroll - 1);
				this.requestRender();
				return;
			}
			if (kb.matches(keyData, "tui.select.down")) {
				this.inspectorScroll++;
				this.requestRender();
				return;
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			if (cards.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? cards.length - 1 : this.selectedIndex - 1;
				this.requestRender();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (cards.length > 0) {
				this.selectedIndex = this.selectedIndex === cards.length - 1 ? 0 : this.selectedIndex + 1;
				this.requestRender();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") && cards.length > 0) {
			this.mode = "inspector";
			this.inspectorScroll = 0;
			this.requestRender();
		}
	}

	invalidate(): void {
		this.cards();
	}

	private cards(): SubagentCard[] {
		const cards = this.getCards();
		this.selectedIndex = cards.length === 0 ? 0 : Math.max(0, Math.min(this.selectedIndex, cards.length - 1));
		return cards;
	}

	private height(): number {
		return Math.max(MIN_BROWSER_ROWS, this.tui?.terminal?.rows ?? 0);
	}

	private selected(cards: SubagentCard[]): SubagentCard | undefined {
		return cards[this.selectedIndex] ?? cards[0];
	}

	private renderSessions(cards: SubagentCard[], width: number, height: number): string[] {
		const lines = ["Sessions"];
		if (cards.length === 0) return frame([...lines, EMPTY_SESSION], width, height);

		const visible = Math.max(1, Math.floor((height - 1) / SESSION_CARD_ROWS));
		const maxStart = Math.max(0, cards.length - visible);
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), maxStart));
		const end = Math.min(cards.length, start + visible);

		for (let index = start; index < end && lines.length < height; index++) {
			const card = cards[index];
			const selected = index === this.selectedIndex;
			lines.push(highlight(this.theme, headerLine(card, this.theme, selected), selected, width));
			if (lines.length >= height) break;
			lines.push(highlight(this.theme, `  ${wrapLines(card.latestAction, width - 2, 1, EMPTY_ACTION)[0] ?? EMPTY_ACTION}`, selected, width));
		}

		if (end < cards.length && lines.length < height) {
			lines.push(`... ${cards.length - end} more`);
		}
		return frame(lines, width, height);
	}

	private renderBrowserSelected(card: SubagentCard | undefined, width: number, height: number): string[] {
		if (!card) return frame([EMPTY_SESSION], width, height);

		const lines = ["Selected", headerLine(card, this.theme)];
		const sections = [
			["Action", card.latestAction || EMPTY_ACTION, "text", BROWSER_ACTION_PREVIEW_LINES],
			["Output", card.outputPreview || EMPTY_OUTPUT, "text", BROWSER_OUTPUT_PREVIEW_LINES],
			["Recent Tool", truncateToWidth(card.toolPreview || EMPTY_TOOL, Math.min(width, 50)), "dim", BROWSER_TOOL_PREVIEW_LINES],
		] as const;

		for (const [label, entry, _color, maxLines] of sections) {
			if (lines.length >= height) break;
			lines.push(label);
			if (lines.length >= height) break;

			for (const line of wrapLines(entry, width, maxLines)) {
				if (lines.length >= height) break;
				lines.push(line);
			}
		}

		return frame(lines, width, height);
	}

	private renderInspector(card: SubagentCard | undefined, width: number, height: number): string[] {
		if (!card) return frame([EMPTY_SESSION], width, height);

		const output = card.outputLines.length > 0 ? card.outputLines : [card.outputPreview || EMPTY_OUTPUT];
		const lines = [headerLine(card, this.theme, false, `Subagent [${card.thread}]`), card.sessionPath, ""];
		const sections = [
			["Action", [card.latestAction || EMPTY_ACTION], "text"],
			["Output", output, "text"],
			["Recent Tool", [card.toolPreview || EMPTY_TOOL], "dim"],
		] as const;

		for (const [index, [label, entries, _color]] of sections.entries()) {
			if (index > 0 && lines.length < height) lines.push("");
			lines.push(label);
			for (const entry of entries) {
				for (const line of wrapLines(entry, width, Number.POSITIVE_INFINITY)) {
					lines.push(line);
				}
			}
		}

		const maxScroll = Math.max(0, lines.length - height);
		this.inspectorScroll = Math.max(0, Math.min(this.inspectorScroll, maxScroll));
		return frame(lines.slice(this.inspectorScroll), width, height);
	}

	private renderBrowser(cards: SubagentCard[], width: number, height: number): string[] {
		const selected = this.selected(cards);
		if (width < WIDE_LAYOUT_MIN_WIDTH) {
			const sessionsHeight = Math.max(4, Math.floor((height - 1) * 0.4));
			return [
				...this.renderSessions(cards, width, sessionsHeight),
				"",
				...this.renderBrowserSelected(selected, width, Math.max(4, height - 1 - sessionsHeight)),
			];
		}

		const leftWidth = Math.max(24, Math.floor((Math.max(24, width - 3)) * 0.42));
		const rightWidth = Math.max(24, Math.max(24, width - 3) - leftWidth);
		const left = this.renderSessions(cards, leftWidth, height);
		const right = this.renderBrowserSelected(selected, rightWidth, height);
		return Array.from({ length: height }, (_, index) => `${pad(left[index] ?? "", leftWidth)} | ${pad(right[index] ?? "", rightWidth)}`);
	}

	render(width: number): string[] {
		const cards = this.cards();
		const height = this.height();
		const header = [
			"Subagents",
			this.mode === "inspector" ? "Live inspector. Up/Down scroll, Esc back to the browser" : "Current session only. Up/Down browse, Enter inspect, Esc close",
			"",
		];
		const bodyHeight = Math.max(6, height - header.length - 1);
		const body = cards.length === 0
			? [EMPTY_SESSION]
			: this.mode === "inspector"
				? this.renderInspector(this.selected(cards), width, bodyHeight)
				: this.renderBrowser(cards, width, bodyHeight);
		return frame([...header, ...body, ""], width, height);
	}
}
