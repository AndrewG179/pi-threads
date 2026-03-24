import { createRequire } from "node:module";

const require = createRequire(__filename);

function loadOptionalModule<T>(id: string): T | null {
	try {
		return require(id) as T;
	} catch {
		return null;
	}
}

type TextInstance = {
	setText?(text: string): void;
	render(width: number): string[];
	invalidate(): void;
};

type MutableTextInstance = {
	setText(text: string): void;
	render(width: number): string[];
	invalidate(): void;
};

type TextLike = {
	new (text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string): TextInstance;
};

type MutableTextLike = {
	new (text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string): MutableTextInstance;
};

type PiTuiModule = {
	Text: TextLike;
	truncateToWidth: (input: string, width: number, ellipsis?: string) => string;
	visibleWidth: (input: string) => number;
};

type TypeboxModule = {
	Type: {
		Object(schema: Record<string, unknown>, options?: Record<string, unknown>): unknown;
		Optional(schema: unknown): unknown;
		String(options?: Record<string, unknown>): unknown;
		Array(schema: unknown, options?: Record<string, unknown>): unknown;
	};
};

const piTui = loadOptionalModule<PiTuiModule>("@mariozechner/pi-tui");
const typebox = loadOptionalModule<TypeboxModule>("@sinclair/typebox");
const BaseText = piTui?.Text as TextLike | undefined;

class FallbackText {
	protected text: string;

	constructor(text = "") {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(_width: number): string[] {
		return this.text.length === 0 ? [""] : this.text.split("\n");
	}

	invalidate(): void {
		// no-op fallback
	}
}

const TextBase = (BaseText ?? FallbackText) as new (
	text?: string,
	paddingX?: number,
	paddingY?: number,
	customBgFn?: (text: string) => string,
) => TextInstance;

class CompatibleText extends TextBase implements MutableTextInstance {
	private currentText: string;

	constructor(text = "", paddingX = 0, paddingY = 0, customBgFn?: (text: string) => string) {
		super(text, paddingX, paddingY, customBgFn);
		this.currentText = text;
	}

	// The installed pi-tui Text renders from a mutable `text` field but exposes no setter.
	setText(text: string): void {
		this.currentText = text;
		(this as TextInstance & { text?: string }).text = text;
		super.invalidate();
	}

	invalidate(): void {
		(this as TextInstance & { text?: string }).text = this.currentText;
		super.invalidate();
	}

	render(width: number): string[] {
		(this as TextInstance & { text?: string }).text = this.currentText;
		const rendered = super.render(width);

		// The installed pi-tui Text can return one string that still contains embedded
		// newlines. Normalize here so host width checks operate on logical terminal rows.
		const normalized = rendered.flatMap((line) => line.split("\n"));
		return normalized.length > 0 ? normalized : [""];
	}
}

export const Text = CompatibleText as MutableTextLike;

export const truncateToWidth = piTui?.truncateToWidth ?? ((input: string, width: number, ellipsis = "...") => {
	if (width <= 0) return "";
	if (input.length <= width) return input;
	if (ellipsis.length >= width) return input.slice(0, width);
	return `${input.slice(0, width - ellipsis.length)}${ellipsis}`;
});

export const visibleWidth = piTui?.visibleWidth ?? ((input: string) => input.replace(/\x1b\[[0-9;]*m/g, "").length);

export const Type = typebox?.Type ?? {
	Object(schema: Record<string, unknown>, options?: Record<string, unknown>) {
		return { type: "object", properties: schema, ...options };
	},
	Optional(schema: unknown) {
		return { optional: true, schema };
	},
	String(options?: Record<string, unknown>) {
		return { type: "string", ...options };
	},
	Array(schema: unknown, options?: Record<string, unknown>) {
		return { type: "array", items: schema, ...options };
	},
};
