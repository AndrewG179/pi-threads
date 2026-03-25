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
};

const WIDE_LAYOUT_MIN_WIDTH = 56;
const MIN_BROWSER_ROWS = 18;
const SESSION_CARD_ROWS = 2;
const EMPTY_SESSION = "No subagent runs in this session.";
const EMPTY_ACTION = "(no action)";
const EMPTY_OUTPUT = "(no output yet)";
const EMPTY_TOOL = "(no recent tool calls)";
const BROWSER_SECTION_CAPS = [20, 10, 2] as const;
const DENSE_BROWSER_SECTION_CAPS = [6, 4, 1] as const;
const BROWSER_SECTION_WEIGHTS = [0.5, 0.4, 0.1] as const;
const DENSE_BROWSER_SECTION_WEIGHTS = [0.6, 0.3, 0.1] as const;

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
	return filled.map((line) => truncateToWidth(pad(line, width), width));
}

function wrapLines(text: string, width: number, maxLines: number, fallback = "(none)"): string[] {
	const wrapped = wrapText(text || fallback, Math.max(12, width), { minWidth: 12 });
	return Number.isFinite(maxLines) ? wrapped.slice(0, maxLines) : wrapped;
}

function allocateBrowserSectionLines(available: number, cardCount: number): number[] {
	if (available <= 0) return [0, 0, 0];
	const caps = cardCount >= 5 ? DENSE_BROWSER_SECTION_CAPS : BROWSER_SECTION_CAPS;
	const weights = cardCount >= 5 ? DENSE_BROWSER_SECTION_WEIGHTS : BROWSER_SECTION_WEIGHTS;

	const budgets = caps.map(() => 0);
	let remaining = available;
	for (let index = 0; index < budgets.length && remaining > 0; index++) {
		budgets[index] = 1;
		remaining--;
	}

	const desired = caps.map((cap, index) => Math.min(cap, Math.floor(available * weights[index])));
	for (let index = 0; index < budgets.length && remaining > 0; index++) {
		const addition = Math.min(Math.max(0, desired[index] - budgets[index]), remaining);
		budgets[index] += addition;
		remaining -= addition;
	}

	while (remaining > 0) {
		let grew = false;
		for (let index = 0; index < budgets.length && remaining > 0; index++) {
			if (budgets[index] >= caps[index]) continue;
			budgets[index]++;
			remaining--;
			grew = true;
		}
		if (!grew) break;
	}

	return budgets;
}

function highlight(theme: any, line: string, selected: boolean, width: number): string {
	const padded = pad(line, width);
	return selected && typeof theme.bg === "function" ? theme.bg("selectedBg", padded) : padded;
}

function headerLine(card: SubagentCard, theme: any, selected = false, title = `[${card.thread}]`): string {
	const prefix = selected ? "> " : "";
	return `${prefix}${theme.fg("accent", title)} ${theme.fg("dim", `${formatStatus(card.status)} ${formatCost(card.accumulatedCost)}`)}`;
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

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (!kb) return;
		const cards = this.cards();
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.mode === "inspector") {
				this.mode = "browser";
				this.inspectorScroll = 0;
			}
			else this.done(undefined);
			return;
		}
		if (this.mode === "inspector") {
			if (kb.matches(keyData, "tui.select.up")) {
				this.inspectorScroll = Math.max(0, this.inspectorScroll - 1);
				return;
			}
			if (kb.matches(keyData, "tui.select.down")) {
				this.inspectorScroll++;
				return;
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			if (cards.length > 0) this.selectedIndex = this.selectedIndex === 0 ? cards.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (cards.length > 0) this.selectedIndex = this.selectedIndex === cards.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") && cards.length > 0) {
			this.mode = "inspector";
			this.inspectorScroll = 0;
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
		const lines = [this.theme.fg("muted", "Sessions")];
		if (cards.length === 0) return frame([...lines, this.theme.fg("muted", EMPTY_SESSION)], width, height);

		const visible = Math.max(1, Math.floor((height - 1) / SESSION_CARD_ROWS));
		const maxStart = Math.max(0, cards.length - visible);
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), maxStart));
		const end = Math.min(cards.length, start + visible);

		for (let index = start; index < end && lines.length < height; index++) {
			const card = cards[index];
			const selected = index === this.selectedIndex;
			lines.push(highlight(this.theme, headerLine(card, this.theme, selected), selected, width));
			if (lines.length >= height) break;
			lines.push(highlight(this.theme, `  ${this.theme.fg("dim", wrapLines(card.latestAction, width - 2, 1, EMPTY_ACTION)[0] ?? EMPTY_ACTION)}`, selected, width));
		}

		if (end < cards.length && lines.length < height) {
			lines.push(this.theme.fg("dim", `... ${cards.length - end} more`));
		}
		return frame(lines, width, height);
	}

	private renderSelected(card: SubagentCard | undefined, width: number, height: number, inspector: boolean, browserCardCount = 1): string[] {
		if (!card) return frame([this.theme.fg("muted", EMPTY_SESSION)], width, height);

		const output = inspector
			? (card.outputLines.length > 0 ? card.outputLines : [card.outputPreview || EMPTY_OUTPUT])
			: (card.outputTail.length > 0 ? card.outputTail : [card.outputPreview || EMPTY_OUTPUT]);
		const toolPreview = inspector ? (card.toolPreview || EMPTY_TOOL) : truncateToWidth(card.toolPreview || EMPTY_TOOL, Math.min(width, 50));
		const lines = inspector
			? [headerLine(card, this.theme, false, `Subagent [${card.thread}]`), this.theme.fg("dim", card.sessionPath), ""]
			: [this.theme.fg("muted", "Selected"), headerLine(card, this.theme)];
		const browserBudgets = allocateBrowserSectionLines(Math.max(0, height - lines.length - 3), browserCardCount);
		const sections = inspector
			? [
				["Action", [card.latestAction || EMPTY_ACTION], "text", Number.POSITIVE_INFINITY],
				["Output", output, "text", Number.POSITIVE_INFINITY],
				["Recent Tool", [toolPreview], "dim", Number.POSITIVE_INFINITY],
			] as const
			: [
				["Action", [card.latestAction || EMPTY_ACTION], "text", browserBudgets[0]],
				["Output", output, "text", browserBudgets[1]],
				["Recent Tool", [toolPreview], "dim", browserBudgets[2]],
			] as const;

		for (const [index, [label, entries, color, maxLines]] of sections.entries()) {
			if (inspector && index > 0 && lines.length < height) lines.push("");
			if (!inspector && lines.length >= height) break;
			lines.push(this.theme.fg("muted", label));
			if (!inspector && maxLines <= 0) continue;
			let remainingSectionLines = maxLines;
			for (const entry of entries) {
				if (!inspector && remainingSectionLines <= 0) break;
				for (const line of wrapLines(entry, width, inspector ? maxLines : remainingSectionLines)) {
					if (!inspector && lines.length >= height) break;
					lines.push(this.theme.fg(color, line));
					if (!inspector) {
						remainingSectionLines--;
						if (remainingSectionLines <= 0) break;
					}
				}
			}
		}
		if (!inspector) return frame(lines, width, height);

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
				...this.renderSelected(selected, width, Math.max(4, height - 1 - sessionsHeight), false, cards.length),
			];
		}

		const leftWidth = Math.max(24, Math.floor((Math.max(24, width - 3)) * 0.42));
		const rightWidth = Math.max(24, Math.max(24, width - 3) - leftWidth);
		const left = this.renderSessions(cards, leftWidth, height);
		const right = this.renderSelected(selected, rightWidth, height, false, cards.length);
		return Array.from({ length: height }, (_, index) => `${pad(left[index] ?? "", leftWidth)} | ${pad(right[index] ?? "", rightWidth)}`);
	}

	render(width: number): string[] {
		const cards = this.cards();
		const height = this.height();
		const header = [
			this.theme.fg("toolTitle", "Subagents"),
			this.theme.fg("dim", this.mode === "inspector" ? "Live inspector. Up/Down scroll, Esc back to the browser" : "Current session only. Up/Down browse, Enter inspect, Esc close"),
			"",
		];
		const bodyHeight = Math.max(6, height - header.length - 1);
		const body = cards.length === 0
			? [this.theme.fg("muted", EMPTY_SESSION)]
			: this.mode === "inspector"
				? this.renderSelected(this.selected(cards), width, bodyHeight, true)
				: this.renderBrowser(cards, width, bodyHeight);
		return frame([...header, ...body, ""], width, height);
	}
}
