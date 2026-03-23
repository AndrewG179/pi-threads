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

export class SubagentBrowser {
	private selectedIndex = 0;

	constructor(
		private readonly cards: SubagentCard[],
		private readonly tui: TuiLike | undefined,
		private readonly theme: any,
		private readonly keybindings: KeybindingMatcher | undefined,
		private readonly done: (result: SubagentCard | undefined) => void,
	) {}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (!kb) return;
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.cards.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.cards.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.cards.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.cards.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			if (this.cards.length === 0) return;
			this.done(this.cards[this.selectedIndex]);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
		}
	}

	invalidate(): void {}

	private getSelectedCard(): SubagentCard | undefined {
		return this.cards[this.selectedIndex] ?? this.cards[0];
	}

	private getViewportHeight(): number {
		return Math.max(MIN_BROWSER_ROWS, this.tui?.terminal?.rows ?? 0);
	}

	private renderSessionsPane(width: number, height: number): string[] {
		const lines = [this.theme.fg("muted", "Sessions")];

		if (this.cards.length === 0) {
			lines.push(this.theme.fg("muted", "No current-branch sessions."));
			return finalizePane(lines, width, height);
		}

		const visibleCards = Math.max(1, Math.floor((height - 1) / SESSION_CARD_ROWS));
		const start = getWindowStart(this.cards.length, visibleCards, this.selectedIndex);
		const end = Math.min(this.cards.length, start + visibleCards);

		for (let index = start; index < end; index++) {
			const card = this.cards[index];
			const selected = index === this.selectedIndex;
			lines.push(maybeHighlight(this.theme, padToWidth(formatCardHeader(card, selected, this.theme), width), selected));
			if (lines.length >= height) break;

			const preview = clampWrapped(card.latestAction || "(no action)", width - 2, 1)[0] ?? "(no action)";
			lines.push(maybeHighlight(this.theme, padToWidth(`  ${this.theme.fg("dim", preview)}`, width), selected));
			if (lines.length >= height) break;
		}

		const hiddenCount = this.cards.length - end;
		if (hiddenCount > 0 && lines.length < height) {
			lines.push(this.theme.fg("dim", `... ${hiddenCount} more`));
		}

		return finalizePane(lines, width, height);
	}

	private renderDetailPane(width: number, height: number): string[] {
		const lines = [this.theme.fg("muted", "Selected")];
		const selected = this.getSelectedCard();
		if (!selected) {
			lines.push(this.theme.fg("muted", "No subagent sessions on the current branch."));
			return finalizePane(lines, width, height);
		}

		lines.push(`${this.theme.fg("accent", `[${selected.thread}]`)} ${this.theme.fg("dim", `${formatStatus(selected.status)} ${formatCost(selected.accumulatedCost)}`)}`);

		const sections: Array<{ label: string; text: string; maxLines: number; color: string }> = [
			{ label: "Action", text: selected.latestAction || "(no action)", maxLines: 2, color: "text" },
			{ label: "Output", text: selected.outputPreview || "(no output yet)", maxLines: 2, color: "text" },
			{ label: "Recent Tool", text: selected.toolPreview || "(no recent tool calls)", maxLines: 1, color: "dim" },
		];

		for (const section of sections) {
			if (lines.length >= height) break;
			lines.push(this.theme.fg("muted", section.label));
			if (lines.length >= height) break;

			for (const line of clampWrapped(section.text, width, section.maxLines)) {
				if (lines.length >= height) break;
				lines.push(this.theme.fg(section.color, line));
			}
		}

		if (selected.parentSessionFile && lines.length < height) {
			lines.push(this.theme.fg("dim", `Parent ${selected.parentSessionFile}`));
		}

		return finalizePane(lines, width, height);
	}

	private renderWide(width: number, height: number): string[] {
		const innerWidth = Math.max(24, width - 3);
		const leftWidth = Math.max(24, Math.floor(innerWidth * 0.42));
		const rightWidth = Math.max(24, innerWidth - leftWidth);
		return combineColumns(
			this.renderSessionsPane(leftWidth, height),
			this.renderDetailPane(rightWidth, height),
			leftWidth,
			rightWidth,
			height,
		);
	}

	private renderNarrow(width: number, height: number): string[] {
		const sessionsHeight = Math.max(4, Math.floor((height - 1) * 0.4));
		const detailHeight = Math.max(4, height - 1 - sessionsHeight);
		return [
			...this.renderSessionsPane(width, sessionsHeight),
			"",
			...this.renderDetailPane(width, detailHeight),
		];
	}

	render(width: number): string[] {
		const headerLines = [
			this.theme.fg("toolTitle", "Subagents"),
			this.theme.fg("dim", "Current branch only. Up/Down browse, Enter open, Esc close"),
			"",
		];
		const viewportHeight = this.getViewportHeight();
		const bodyHeight = Math.max(6, viewportHeight - headerLines.length);

		if (this.cards.length === 0) {
			return finalizePane(
				[...headerLines, this.theme.fg("muted", "No subagent sessions on the current branch.")],
				width,
				viewportHeight,
			).map((line) => truncateToWidth(line, width));
		}

		return finalizePane(
			[
				...headerLines,
				...(width >= WIDE_LAYOUT_MIN_WIDTH ? this.renderWide(width, bodyHeight) : this.renderNarrow(width, bodyHeight)),
			],
			width,
			viewportHeight,
		).map((line) => truncateToWidth(line, width));
	}
}
