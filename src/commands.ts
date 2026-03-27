import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ThreadRegistry } from "./state.ts";

export function updateStatusBar(ctx: { ui: { setStatus: (key: string, text: string) => void } }, registry: ThreadRegistry): void {
	const thinkingLabel = registry.subagentThinking || "default";
	const statusText = `sub: ${registry.subagentModel} | thinking: ${thinkingLabel}`;
	ctx.ui.setStatus("subagent-model", `\x1b[${(process.stdout.columns ?? 120) - statusText.length + 1}G\x1b[2m${statusText}\x1b[0m`);
}

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "threads", "config.json");

export async function persistGlobalConfig(registry: ThreadRegistry): Promise<void> {
	try {
		const dir = dirname(GLOBAL_CONFIG_PATH);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify({
			model: registry.subagentModel,
			thinking: registry.subagentThinking,
		}, null, 2) + "\n");
	} catch { /* best-effort */ }
}

export async function loadGlobalConfig(): Promise<{ model?: string; thinking?: string } | null> {
	try {
		const raw = await fs.promises.readFile(GLOBAL_CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		return {
			model: typeof parsed.model === "string" ? parsed.model : undefined,
			thinking: typeof parsed.thinking === "string" ? parsed.thinking : undefined,
		};
	} catch {
		return null;
	}
}

export async function persistConfig(pi: ExtensionAPI, registry: ThreadRegistry): Promise<void> {
	// Appends a new config entry to the session. On reload, all thread-config
	// entries are applied in order and the last one wins by overwrite
	// (see initSessionState in index.ts). Repeated appends are harmless
	// but create minor session file bloat.
	pi.appendEntry("thread-config", { model: registry.subagentModel, thinking: registry.subagentThinking });
	await persistGlobalConfig(registry);
}

export function registerCommands(pi: ExtensionAPI, registry: ThreadRegistry): void {
	pi.registerCommand("model-sub", {
		description: "Set the subagent model for thread workers (supports :thinking suffix, e.g. sonnet:high)",
		handler: async (args, ctx) => {
			const input = args.trim();

			// Direct match via argument (like /model <term>)
			if (input) {
				// Parse optional :thinking suffix (e.g., "sonnet:high", "anthropic/claude-sonnet-4-5:medium")
				let modelInput = input;
				let thinkingSuffix: string | undefined;
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
				const lastColon = input.lastIndexOf(":");
				if (lastColon > 0) {
					const suffix = input.substring(lastColon + 1).toLowerCase();
					if (levels.includes(suffix)) {
						modelInput = input.substring(0, lastColon);
						thinkingSuffix = suffix;
					}
				}

				const slashIndex = modelInput.indexOf("/");
				if (slashIndex > 0) {
					const provider = modelInput.substring(0, slashIndex);
					const modelId = modelInput.substring(slashIndex + 1);
					const found = ctx.modelRegistry.find(provider, modelId);
					if (found) {
						registry.subagentModel = `${provider}/${modelId}`;
						if (thinkingSuffix) registry.setThinking(thinkingSuffix);
						updateStatusBar(ctx, registry);
						const thinkingMsg = thinkingSuffix ? ` | thinking: ${thinkingSuffix}` : "";
						ctx.ui.notify(`Subagent model set to: ${registry.subagentModel}${thinkingMsg}`, "info");
						await persistConfig(pi, registry);
						return;
					}
				}
				// Fuzzy match
				const allModels = ctx.modelRegistry.getAvailable();
				const matches = allModels.filter((m: { id: string; name?: string; provider: string }) =>
					`${m.id} ${m.provider} ${m.provider}/${m.id}`.toLowerCase().includes(modelInput.toLowerCase())
				);
				if (matches.length === 1) {
					registry.subagentModel = `${matches[0].provider}/${matches[0].id}`;
					if (thinkingSuffix) registry.setThinking(thinkingSuffix);
					updateStatusBar(ctx, registry);
					const thinkingMsg = thinkingSuffix ? ` | thinking: ${thinkingSuffix}` : "";
					ctx.ui.notify(`Subagent model set to: ${registry.subagentModel}${thinkingMsg}`, "info");
					await persistConfig(pi, registry);
					return;
				}
				// Fall through to picker with search pre-filled
			}

			// Show interactive picker (mirrors /model UI)
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models available", "error");
				return;
			}

			// Sort: current model first, then alphabetical by provider
			const items = available
				.map((m: { id: string; name?: string; provider: string }) => ({
					id: m.id,
					name: m.name || m.id,
					provider: m.provider,
					isCurrent: `${m.provider}/${m.id}` === registry.subagentModel,
				}))
				.sort((a: { isCurrent: boolean; provider: string }, b: { isCurrent: boolean; provider: string }) => {
					if (a.isCurrent && !b.isCurrent) return -1;
					if (!a.isCurrent && b.isCurrent) return 1;
					return a.provider.localeCompare(b.provider);
				});

			const { DynamicBorder } = await import("@mariozechner/pi-coding-agent");
			const { Container, Text, Input, matchesKey, Key } = await import("@mariozechner/pi-tui");

			const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const maxVisible = 10;
				let selectedIndex = 0;
				let filtered = [...items];
				let searchText = input || "";

				// Apply initial search if provided
				if (searchText) {
					applyFilter();
				}

				function applyFilter() {
					const q = searchText.toLowerCase();
					if (!q) {
						filtered = [...items];
					} else {
						filtered = items.filter((m: { id: string; name?: string; provider: string }) =>
							`${m.id} ${m.provider} ${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q)
						);
					}
					selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
				}

				const container = new Container();

				const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(topBorder);

				const headerText = new Text(theme.fg("muted", "  Only showing models with configured API keys. Configure keys in settings or environment."), 0, 1);
				container.addChild(headerText);

				const searchInput = new Input(
					(s: string) => theme.fg("text", s),
					(s: string) => theme.fg("accent", s),
					80,
					"Search models..."
				);
				if (searchText) {
					// Pre-fill search
					for (const ch of searchText) {
						searchInput.handleInput(ch);
					}
				}
				container.addChild(searchInput);

				// Spacer
				container.addChild(new Text("", 0, 1));

				// Model list (rendered dynamically)
				const listText = new Text("", 0, 0);
				container.addChild(listText);

				// Detail line
				const detailText = new Text("", 0, 1);
				container.addChild(detailText);

				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(bottomBorder);

				function renderList() {
					if (filtered.length === 0) {
						listText.setText(theme.fg("warning", "  No matching models"));
						detailText.setText("");
						return;
					}

					// Scroll window centred on selectedIndex
					let startIndex = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
					if (startIndex + maxVisible > filtered.length) {
						startIndex = Math.max(0, filtered.length - maxVisible);
					}
					const endIndex = Math.min(startIndex + maxVisible, filtered.length);

					const lines: string[] = [];
					for (let i = startIndex; i < endIndex; i++) {
						const m = filtered[i];
						const isSelected = i === selectedIndex;
						const checkmark = m.isCurrent ? theme.fg("success", " ✓") : "";
						const providerBadge = theme.fg("muted", `[${m.provider}]`);

						if (isSelected) {
							lines.push(`${theme.fg("accent", "→ " + m.id)} ${providerBadge}${checkmark}`);
						} else {
							lines.push(`  ${m.id} ${providerBadge}${checkmark}`);
						}
					}

					// Scroll indicator
					if (filtered.length > maxVisible) {
						lines.push(theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`));
					}

					listText.setText(lines.join("\n"));

					// Detail line: model name
					const sel = filtered[selectedIndex];
					if (sel) {
						detailText.setText(theme.fg("muted", `  Model Name: ${sel.name}`));
					} else {
						detailText.setText("");
					}
				}

				renderList();

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.up)) {
							selectedIndex = selectedIndex <= 0 ? filtered.length - 1 : selectedIndex - 1;
							renderList();
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							selectedIndex = selectedIndex >= filtered.length - 1 ? 0 : selectedIndex + 1;
							renderList();
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							if (filtered.length > 0) {
								const sel = filtered[selectedIndex];
								done(`${sel.provider}/${sel.id}`);
							}
						} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(null);
						} else {
							searchInput.handleInput(data);
							searchText = searchInput.value;
							applyFilter();
							renderList();
							tui.requestRender();
						}
					},
				};
			});

			if (!choice) return;

			registry.subagentModel = choice;

			// Step 2: pick thinking level
			const thinkingLevels = [
				{ value: undefined,    label: "default",  desc: "Use pi default from settings" },
				{ value: "off",        label: "off",      desc: "No reasoning — fastest, cheapest" },
				{ value: "minimal",    label: "minimal",  desc: "1k token budget — barely any reasoning" },
				{ value: "low",        label: "low",      desc: "2k token budget — light reasoning" },
				{ value: "medium",     label: "medium",   desc: "8k token budget — moderate reasoning" },
				{ value: "high",       label: "high",     desc: "16k token budget — complex tasks" },
				{ value: "xhigh",      label: "xhigh",    desc: "Max reasoning — Opus 4.6 / GPT-5 only" },
			];

			const chosenThinking = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				let selectedIndex = thinkingLevels.findIndex((l) => l.value === registry.subagentThinking);
				if (selectedIndex < 0) selectedIndex = 0;

				const container = new Container();
				const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(topBorder);

				const headerText = new Text(theme.fg("muted", `  Select thinking level for ${registry.subagentModel}`), 0, 1);
				container.addChild(headerText);

				container.addChild(new Text("", 0, 1));

				const listText = new Text("", 0, 0);
				container.addChild(listText);

				const descText = new Text("", 0, 1);
				container.addChild(descText);

				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(bottomBorder);

				function renderThinkingList() {
					const lines = thinkingLevels.map((l, i) => {
						const isSelected = i === selectedIndex;
						const isCurrent = l.value === registry.subagentThinking || (l.value === undefined && registry.subagentThinking === undefined);
						const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
						if (isSelected) {
							return `${theme.fg("accent", "→ " + l.label)}${checkmark}`;
						}
						return `  ${l.label}${checkmark}`;
					});
					listText.setText(lines.join("\n"));
					descText.setText(theme.fg("muted", `  ${thinkingLevels[selectedIndex]?.desc || ""}`));
				}

				renderThinkingList();

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.up)) {
							selectedIndex = selectedIndex <= 0 ? thinkingLevels.length - 1 : selectedIndex - 1;
							renderThinkingList();
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							selectedIndex = selectedIndex >= thinkingLevels.length - 1 ? 0 : selectedIndex + 1;
							renderThinkingList();
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							done(thinkingLevels[selectedIndex]?.value ?? "__default__");
						} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(null);
						}
					},
				};
			});

			if (chosenThinking !== null) {
				registry.setThinking(chosenThinking === "__default__" ? undefined : chosenThinking);
			}

			updateStatusBar(ctx, registry);
			const thinkingMsg = registry.subagentThinking ? ` | thinking: ${registry.subagentThinking}` : "";
			ctx.ui.notify(`Subagent model set to: ${registry.subagentModel}${thinkingMsg}`, "info");
			await persistConfig(pi, registry);
		},
	});
}
