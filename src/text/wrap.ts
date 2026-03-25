export interface WrapTextOptions {
	minWidth?: number;
}

export function wrapText(text: string | undefined, width: number, options: WrapTextOptions = {}): string[] {
	if (!text) return [""];

	const minWidth = options.minWidth ?? 10;
	if (width < minWidth) return [text];

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
