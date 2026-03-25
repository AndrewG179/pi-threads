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

type InputInstance = {
	focused?: boolean;
	value?: string;
	setValue?(value: string): void;
	getValue?(): string;
	handleInput(data: string): void;
	render(width: number): string[];
	invalidate(): void;
};

type InputLike = {
	new (
		textRenderer?: (text: string) => string,
		cursorRenderer?: (text: string) => string,
		width?: number,
		placeholder?: string,
	): InputInstance;
};

type PiTuiModule = {
	Text: TextLike;
	Input?: InputLike;
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
const BaseInput = piTui?.Input as InputLike | undefined;

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

export type SearchInputLike = {
	focused: boolean;
	setValue(value: string): void;
	getValue(): string;
	handleInput(data: string): void;
	render(width: number): string[];
	invalidate(): void;
};

class FallbackInput implements SearchInputLike {
	focused = false;
	private value = "";

	setValue(value: string): void {
		this.value = value;
	}

	getValue(): string {
		return this.value;
	}

	handleInput(data: string): void {
		this.value += data;
	}

	render(_width: number): string[] {
		return [this.value];
	}

	invalidate(): void {
		// no-op fallback
	}
}

function setSearchInputValue(input: InputInstance, value: string): void {
	if (typeof input.setValue === "function") {
		input.setValue(value);
		return;
	}

	if (typeof input.handleInput !== "function") {
		return;
	}

	if ("value" in input) {
		input.value = "";
		for (const char of value) {
			input.handleInput(char);
		}
	}
}

function getSearchInputValue(input: InputInstance): string {
	if (typeof input.getValue === "function") {
		return input.getValue();
	}
	return typeof input.value === "string" ? input.value : "";
}

export function createSearchInput(
	theme: { fg?: (color: string, text: string) => string },
	initialValue = "",
	InputCtor: InputLike | undefined = BaseInput,
): SearchInputLike {
	if (typeof InputCtor !== "function") {
		const fallback = new FallbackInput();
		fallback.setValue(initialValue);
		return fallback;
	}

	const input = new InputCtor(
		(text: string) => theme.fg ? theme.fg("text", text) : text,
		(text: string) => theme.fg ? theme.fg("accent", text) : text,
		80,
		"Search models...",
	);
	const wrappedInput: SearchInputLike = {
		get focused() {
			return Boolean(input.focused);
		},
		set focused(value: boolean) {
			input.focused = value;
		},
		setValue(value: string) {
			setSearchInputValue(input, value);
		},
		getValue() {
			return getSearchInputValue(input);
		},
		handleInput(data: string) {
			input.handleInput(data);
		},
		render(width: number) {
			return input.render(width);
		},
		invalidate() {
			input.invalidate();
		},
	};
	wrappedInput.setValue(initialValue);
	return wrappedInput;
}

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
