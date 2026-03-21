import { getEditorKeybindings, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import type { SubagentCard } from "./metadata";

function wrapText(text: string, width: number): string[] {
	if (!text) return [""];
	if (width < 12) return [text];

	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (!paragraph.trim()) {
			lines.push("");
			continue;
		}
		const words = paragraph.split(/\s+/);
		let current = "";
		for (const word of words) {
			if (current && current.length + word.length + 1 > width) {
				lines.push(current);
				current = word;
			} else {
				current = current ? `${current} ${word}` : word;
			}
		}
		if (current) lines.push(current);
	}

	return lines.length > 0 ? lines : [""];
}

function padToWidth(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(2)}`;
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

export class SubagentSelector {
	private selectedIndex = 0;

	constructor(
		private readonly cards: SubagentCard[],
		private readonly theme: any,
		private readonly done: (result: SubagentCard | undefined) => void,
	) {}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectUp")) {
			if (this.cards.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.cards.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			if (this.cards.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.cards.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(keyData, "selectConfirm")) {
			this.done(this.cards[this.selectedIndex]);
			return;
		}
		if (kb.matches(keyData, "selectCancel")) {
			this.done(undefined);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const bodyWidth = Math.max(24, width - 4);
		const lines: string[] = [];

		lines.push(this.theme.fg("toolTitle", "Subagents"));
		lines.push(this.theme.fg("dim", "Enter to open, Esc to close"));
		lines.push("");

		if (this.cards.length === 0) {
			lines.push(this.theme.fg("muted", "No thread sessions found in .pi/threads"));
			return lines.map((line) => truncateToWidth(line, width));
		}

		for (let i = 0; i < this.cards.length; i++) {
			const card = this.cards[i];
			const isSelected = i === this.selectedIndex;
			const statusColor = card.status === "done"
				? "success"
				: card.status === "escalated"
					? "warning"
					: card.status === "aborted"
						? "error"
						: "muted";

			const header = `${this.theme.fg("accent", `[${card.thread}]`)} ${this.theme.fg(statusColor, formatStatus(card.status))} ${this.theme.fg("dim", formatCost(card.accumulatedCost))}`;
			const actionLines = wrapText(card.latestAction || "(no action)", bodyWidth).slice(0, 2);
			const outputLines = wrapText(card.outputPreview || "(no output yet)", bodyWidth).slice(0, 2);
			const toolLine = card.toolPreview ? card.toolPreview : "(no recent tool calls)";

			const cardLines = [
				header,
				this.theme.fg("muted", "action ") + this.theme.fg("text", actionLines[0] ?? ""),
				...(actionLines.slice(1).map((line) => this.theme.fg("text", line))),
				this.theme.fg("muted", "output ") + this.theme.fg("text", outputLines[0] ?? ""),
				...(outputLines.slice(1).map((line) => this.theme.fg("text", line))),
				this.theme.fg("muted", "tool   ") + this.theme.fg("dim", toolLine),
			];

			for (const line of cardLines) {
				const padded = padToWidth(`  ${line}`, width);
				lines.push(isSelected ? this.theme.bg("selectedBg", padded) : padded);
			}

			if (i < this.cards.length - 1) lines.push("");
		}

		return lines.map((line) => truncateToWidth(line, width));
	}
}
