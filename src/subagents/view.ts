import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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
const EMPTY_ACTION = "(no action)";
const EMPTY_OUTPUT = "(no output yet)";
const EMPTY_TOOL = "(no recent tool calls)";
const EMPTY_SESSION_MESSAGE = "No subagent runs in this session.";

function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

function formatStatus(status: SubagentCard["status"]): string {
	switch (status) {
		case "done":
			return "Done";
		case "escalated":
			return "Escalated";
		case "aborted":
			return "Aborted";
		default:
			return "Unknown";
	}
}

function padToWidth(input: string, width: number): string {
	const clipped = truncateToWidth(input, width);
	const padding = Math.max(0, width - visibleWidth(clipped));
	return clipped + " ".repeat(padding);
}

function combineColumns(leftLines: string[], rightLines: string[], leftWidth: number, rightWidth: number, rows: number): string[] {
	const lines: string[] = [];
	for (let i = 0; i < rows; i++) {
		const left = padToWidth(leftLines[i] ?? "", leftWidth);
		const right = padToWidth(rightLines[i] ?? "", rightWidth);
		lines.push(`${left} | ${right}`);
	}
	return lines;
}

function clampWrapped(text: string, width: number, maxLines: number): string[] {
	return wrapText(text || "(none)", Math.max(12, width), { minWidth: 12 }).slice(0, maxLines);
}

function formatCardHeader(card: SubagentCard, selected: boolean, theme: any): string {
	const marker = selected ? ">" : " ";
	return `${marker} ${theme.fg("accent", `[${card.thread}]`)} ${theme.fg("dim", `${formatStatus(card.status)} ${formatCost(card.accumulatedCost)}`)}`;
}

function finalizePane(lines: string[], width: number, height: number): string[] {
	const output = lines.slice(0, height).map((line) => padToWidth(line, width));
	while (output.length < height) {
		output.push(" ".repeat(width));
	}
	return output;
}

function renderFrame(lines: string[], width: number, height: number): string[] {
	return finalizePane(lines, width, height).map((line) => truncateToWidth(line, width));
}

function getWindowStart(total: number, capacity: number, selectedIndex: number): number {
	if (total <= capacity) return 0;
	const maxStart = Math.max(0, total - capacity);
	const centered = selectedIndex - Math.floor(capacity / 2);
	return Math.max(0, Math.min(centered, maxStart));
}

function maybeHighlight(theme: any, line: string, selected: boolean): string {
	if (!selected || typeof theme.bg !== "function") return line;
	return theme.bg("selectedBg", line);
}

function formatSelectedHeader(card: SubagentCard, title: string, theme: any): string {
	return `${theme.fg("accent", title)} ${theme.fg("dim", `${formatStatus(card.status)} ${formatCost(card.accumulatedCost)}`)}`;
}

function appendSection(params: {
	lines: string[];
	height: number;
	theme: any;
	width: number;
	label: string;
	entries: readonly string[];
	color: string;
	maxLines: number;
}): void {
	const { lines, height, theme, width, label, entries, color, maxLines } = params;
	if (lines.length >= height) return;
	lines.push(theme.fg("muted", label));
	for (const entry of entries) {
		for (const line of clampWrapped(entry, width, maxLines)) {
			if (lines.length >= height) return;
			lines.push(theme.fg(color, line));
		}
	}
}

export class SubagentBrowser {
	private selectedIndex = 0;
	private mode: "browser" | "inspector" = "browser";

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
		const cards = this.getCurrentCards();
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.mode === "inspector") {
				this.mode = "browser";
				return;
			}
			this.done(undefined);
			return;
		}
		if (this.mode === "inspector") {
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			if (cards.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? cards.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (cards.length === 0) return;
			this.selectedIndex = this.selectedIndex === cards.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
			return;
		}
	}

	invalidate(): void {
		this.clampSelection(this.getCurrentCards());
	}

	private confirmSelection(): void {
		const cards = this.getCurrentCards();
		if (cards.length === 0) return;
		this.mode = "inspector";
	}

	private clampSelection(cards: SubagentCard[]): void {
		if (cards.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, cards.length - 1));
	}

	private getCurrentCards(): SubagentCard[] {
		const cards = this.getCards();
		this.clampSelection(cards);
		return cards;
	}

	private getSelectedCard(cards: SubagentCard[]): SubagentCard | undefined {
		return cards[this.selectedIndex] ?? cards[0];
	}

	private getViewportHeight(): number {
		return Math.max(MIN_BROWSER_ROWS, this.tui?.terminal?.rows ?? 0);
	}

	private renderSessionsPane(cards: SubagentCard[], width: number, height: number): string[] {
		const lines = [this.theme.fg("muted", "Sessions")];

		if (cards.length === 0) {
			lines.push(this.theme.fg("muted", EMPTY_SESSION_MESSAGE));
			return finalizePane(lines, width, height);
		}

		const visibleCards = Math.max(1, Math.floor((height - 1) / SESSION_CARD_ROWS));
		const start = getWindowStart(cards.length, visibleCards, this.selectedIndex);
		const end = Math.min(cards.length, start + visibleCards);

		for (let index = start; index < end; index++) {
			const card = cards[index];
			const selected = index === this.selectedIndex;
			lines.push(maybeHighlight(this.theme, padToWidth(formatCardHeader(card, selected, this.theme), width), selected));
			if (lines.length >= height) break;

			const preview = clampWrapped(card.latestAction || "(no action)", width - 2, 1)[0] ?? "(no action)";
			lines.push(maybeHighlight(this.theme, padToWidth(`  ${this.theme.fg("dim", preview)}`, width), selected));
			if (lines.length >= height) break;
		}

		const hiddenCount = cards.length - end;
		if (hiddenCount > 0 && lines.length < height) {
			lines.push(this.theme.fg("dim", `... ${hiddenCount} more`));
		}

		return finalizePane(lines, width, height);
	}

	private renderSelectedPane(cards: SubagentCard[], width: number, height: number, mode: "detail" | "inspector"): string[] {
		const lines = mode === "detail" ? [this.theme.fg("muted", "Selected")] : [];
		const selected = this.getSelectedCard(cards);
		if (!selected) {
			lines.push(this.theme.fg("muted", EMPTY_SESSION_MESSAGE));
			return finalizePane(lines, width, height);
		}

		if (mode === "inspector") {
			lines.push(formatSelectedHeader(selected, `Subagent [${selected.thread}]`, this.theme));
			lines.push(this.theme.fg("dim", selected.sessionPath));
			lines.push("");
		} else {
			lines.push(formatSelectedHeader(selected, `[${selected.thread}]`, this.theme));
		}

		const sections = [
			{ label: "Action", entries: [selected.latestAction || EMPTY_ACTION], color: "text", maxLines: mode === "inspector" ? 3 : 2 },
			{
				label: "Output",
				entries: mode === "inspector" ? (selected.outputTail.length > 0 ? selected.outputTail : [selected.outputPreview || EMPTY_OUTPUT]) : [selected.outputPreview || EMPTY_OUTPUT],
				color: "text",
				maxLines: 2,
			},
			{ label: "Recent Tool", entries: [selected.toolPreview || EMPTY_TOOL], color: "dim", maxLines: mode === "inspector" ? 2 : 1 },
		] as const;

		for (const [index, section] of sections.entries()) {
			if (mode === "inspector" && index > 0 && lines.length < height) {
				lines.push("");
			}
			appendSection({
				lines,
				height,
				theme: this.theme,
				width,
				label: section.label,
				entries: section.entries,
				color: section.color,
				maxLines: section.maxLines,
			});
		}

		return finalizePane(lines, width, height);
	}

	private renderWide(cards: SubagentCard[], width: number, height: number): string[] {
		const innerWidth = Math.max(24, width - 3);
		const leftWidth = Math.max(24, Math.floor(innerWidth * 0.42));
		const rightWidth = Math.max(24, innerWidth - leftWidth);
		return combineColumns(
			this.renderSessionsPane(cards, leftWidth, height),
			this.renderSelectedPane(cards, rightWidth, height, "detail"),
			leftWidth,
			rightWidth,
			height,
		);
	}

	private renderNarrow(cards: SubagentCard[], width: number, height: number): string[] {
		const sessionsHeight = Math.max(4, Math.floor((height - 1) * 0.4));
		const detailHeight = Math.max(4, height - 1 - sessionsHeight);
		return [
			...this.renderSessionsPane(cards, width, sessionsHeight),
			"",
			...this.renderSelectedPane(cards, width, detailHeight, "detail"),
		];
	}

	render(width: number): string[] {
		const cards = this.getCurrentCards();
		const headerLines = [
			this.theme.fg("toolTitle", "Subagents"),
			this.theme.fg(
				"dim",
				this.mode === "inspector"
					? "Live inspector. Esc back to the browser"
					: "Current session only. Up/Down browse, Enter inspect, Esc close",
			),
			"",
		];
		const viewportHeight = this.getViewportHeight();
		const bodyHeight = Math.max(6, viewportHeight - headerLines.length);

		const bodyLines = cards.length === 0
			? [this.theme.fg("muted", EMPTY_SESSION_MESSAGE)]
			: this.mode === "inspector"
				? this.renderSelectedPane(cards, width, bodyHeight, "inspector")
				: width >= WIDE_LAYOUT_MIN_WIDTH
					? this.renderWide(cards, width, bodyHeight)
					: this.renderNarrow(cards, width, bodyHeight);

		return renderFrame([...headerLines, ...bodyLines], width, viewportHeight);
	}
}
