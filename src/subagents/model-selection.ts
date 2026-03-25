export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelDescriptor extends ModelLike {}

export interface ModelRegistryLike {
	getAvailable: () => Promise<readonly ModelLike[]> | readonly ModelLike[];
}

export function toModelDescriptor(model: ModelLike | undefined): ModelDescriptor | undefined {
	if (!model) return undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
	};
}

export function formatModelIdentifier(model: Pick<ModelDescriptor, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function isModelOverrideResetQuery(query: string): boolean {
	return new Set(["clear", "default", "inherit", "none", "reset"]).has(query.trim().toLowerCase());
}

function compareModels(left: ModelDescriptor, right: ModelDescriptor): number {
	const providerComparison = left.provider.localeCompare(right.provider);
	if (providerComparison !== 0) return providerComparison;
	const idComparison = left.id.localeCompare(right.id);
	if (idComparison !== 0) return idComparison;
	return (left.name ?? "").localeCompare(right.name ?? "");
}

function matchScore(model: ModelDescriptor, query: string): number {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return 1;

	const ref = formatModelIdentifier(model).toLowerCase();
	const id = model.id.toLowerCase();
	const provider = model.provider.toLowerCase();
	const name = (model.name ?? "").toLowerCase();
	const fields = [ref, id, provider, name].filter(Boolean);

	if (ref === normalizedQuery) return 500;
	if (id === normalizedQuery) return 450;
	if (provider === normalizedQuery) return 300;
	if (name === normalizedQuery) return 425;
	if (ref.startsWith(normalizedQuery)) return 400;
	if (id.startsWith(normalizedQuery)) return 350;
	if (name.startsWith(normalizedQuery)) return 325;
	if (provider.startsWith(normalizedQuery)) return 250;
	if (fields.some((field) => field.includes(normalizedQuery))) return 200;
	if (normalizedQuery.split(/\s+/).every((token) => fields.some((field) => field.includes(token)))) return 150;
	return -1;
}

export function findFuzzyModelMatches(models: readonly ModelDescriptor[], query: string): ModelDescriptor[] {
	const normalizedQuery = query.trim();
	return [...models]
		.map((model) => ({ model, score: matchScore(model, normalizedQuery) }))
		.filter((entry) => entry.score >= 0)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			return compareModels(left.model, right.model);
		})
		.map((entry) => entry.model);
}

export async function getAvailableModels(modelRegistry: ModelRegistryLike | undefined): Promise<ModelDescriptor[]> {
	if (!modelRegistry?.getAvailable) return [];
	const available = await Promise.resolve(modelRegistry.getAvailable());
	return available.map((model) => toModelDescriptor(model)).filter((model): model is ModelDescriptor => model !== undefined);
}

export function resolveEffectiveSubagentModel(
	parentModel: Pick<ModelDescriptor, "provider" | "id"> | undefined,
	overrideModel: Pick<ModelDescriptor, "provider" | "id"> | undefined,
): string | undefined {
	return overrideModel ? formatModelIdentifier(overrideModel) : parentModel ? formatModelIdentifier(parentModel) : undefined;
}

export function buildSubagentModelStatusText(
	parentModel: Pick<ModelDescriptor, "provider" | "id"> | undefined,
	overrideModel: Pick<ModelDescriptor, "provider" | "id"> | undefined,
): string {
	if (overrideModel) {
		return `sub: override ${formatModelIdentifier(overrideModel)}`;
	}
	if (parentModel) {
		return `sub: inherit ${formatModelIdentifier(parentModel)}`;
	}
	return "sub: inherit current session model";
}

export function buildSubagentModelPromptSection(
	parentModel: Pick<ModelDescriptor, "provider" | "id"> | undefined,
	overrideModel: Pick<ModelDescriptor, "provider" | "id"> | undefined,
): string {
	if (overrideModel) {
		return [
			"## Worker Model Selection",
			"- Explicit `/model-sub` override is active.",
			`- Dispatch workers should use \`${formatModelIdentifier(overrideModel)}\` unless the user changes the override.`,
		].join("\n");
	}

	return [
		"## Worker Model Selection",
		"- No `/model-sub` override is active.",
		"- Dispatch workers inherit the parent session model by default.",
		parentModel
			? `- Current parent session model: \`${formatModelIdentifier(parentModel)}\`.`
			: "- Current parent session model is not available in extension context for this turn.",
	].join("\n");
}
