import * as fs from "node:fs";
import * as path from "node:path";

export interface ThreadsState {
	enabled: boolean;
}

export const DEFAULT_THREADS_STATE: ThreadsState = {
	enabled: false,
};

function getThreadsStatePath(cwd: string): string {
	return path.join(cwd, ".pi", "threads", "state.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadThreadsState(cwd: string): ThreadsState {
	const statePath = getThreadsStatePath(cwd);
	if (!fs.existsSync(statePath)) {
		return { ...DEFAULT_THREADS_STATE };
	}

	try {
		const raw = fs.readFileSync(statePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isPlainObject(parsed)) {
			return { ...DEFAULT_THREADS_STATE };
		}

		return {
			enabled: parsed.enabled === true,
		};
	} catch {
		return { ...DEFAULT_THREADS_STATE };
	}
}

export function saveThreadsState(cwd: string, state: ThreadsState): void {
	const statePath = getThreadsStatePath(cwd);
	fs.mkdirSync(path.dirname(statePath), { recursive: true });

	const payload: ThreadsState = {
		enabled: state.enabled === true,
	};

	fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
