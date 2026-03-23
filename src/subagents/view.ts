import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import type { SubagentCard } from "./metadata";
import { wrapText } from "../text/wrap";

type KeybindingMatcher = {
	matches(input: string, command: string): boolean;
};

const WIDE_LAYOUT_MIN_WIDTH = 56;
const WIDE_LAYOUT_ROWS = 8;
const NARROW_SESSIONS_ROWS = 5;
const NARROW_DETAILS_ROWS = 7;
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

	private renderWide(width: number): string[] {
		const innerWidth = Math.max(24, width - 3);
		const leftWidth = Math.max(24, Math.floor(innerWidth * 0.42));
		const rightWidth = Math.max(24, innerWidth - leftWidth);
		return combineColumns(
			this.renderSessionsPane(leftWidth, WIDE_LAYOUT_ROWS),
			this.renderDetailPane(rightWidth, WIDE_LAYOUT_ROWS),
			leftWidth,
			rightWidth,
			WIDE_LAYOUT_ROWS,
		);
	}

	private renderNarrow(width: number): string[] {
		return [
			...this.renderSessionsPane(width, NARROW_SESSIONS_ROWS),
			"",
			...this.renderDetailPane(width, NARROW_DETAILS_ROWS),
		];
	}

	render(width: number): string[] {
		const lines = [
			this.theme.fg("toolTitle", "Subagents"),
			this.theme.fg("dim", "Current branch only. Up/Down browse, Enter open, Esc close"),
			"",
		];

		if (this.cards.length === 0) {
			lines.push(this.theme.fg("muted", "No subagent sessions on the current branch."));
			return lines.map((line) => truncateToWidth(line, width));
		}

		return [...lines, ...(width >= WIDE_LAYOUT_MIN_WIDTH ? this.renderWide(width) : this.renderNarrow(width))].map((line) =>
			truncateToWidth(line, width),
		);
	}
}
