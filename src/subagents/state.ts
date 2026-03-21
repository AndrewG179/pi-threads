import * as fs from "node:fs";
import * as path from "node:path";

export interface ThreadsState {
	enabled: boolean;
	parentBySession: Record<string, string>;
}

export const DEFAULT_THREADS_STATE: ThreadsState = {
	enabled: false,
	parentBySession: {},
};

function getThreadsStatePath(cwd: string): string {
	return path.join(cwd, ".pi", "threads", "state.json");
}

function normalizeSessionPath(sessionPath: string): string {
	return path.resolve(sessionPath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadThreadsState(cwd: string): ThreadsState {
	const statePath = getThreadsStatePath(cwd);
	if (!fs.existsSync(statePath)) {
		return { ...DEFAULT_THREADS_STATE, parentBySession: {} };
	}

	try {
		const raw = fs.readFileSync(statePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isPlainObject(parsed)) {
			return { ...DEFAULT_THREADS_STATE, parentBySession: {} };
		}

		const parentBySession: Record<string, string> = {};
		if (isPlainObject(parsed.parentBySession)) {
			for (const [childSession, parentSession] of Object.entries(parsed.parentBySession)) {
				if (typeof parentSession === "string") {
					parentBySession[normalizeSessionPath(childSession)] = normalizeSessionPath(parentSession);
				}
			}
		}

		return {
			enabled: parsed.enabled === true,
			parentBySession,
		};
	} catch {
		return { ...DEFAULT_THREADS_STATE, parentBySession: {} };
	}
}

export function saveThreadsState(cwd: string, state: ThreadsState): void {
	const statePath = getThreadsStatePath(cwd);
	fs.mkdirSync(path.dirname(statePath), { recursive: true });

	const payload: ThreadsState = {
		enabled: state.enabled === true,
		parentBySession: {},
	};

	for (const [childSession, parentSession] of Object.entries(state.parentBySession)) {
		payload.parentBySession[normalizeSessionPath(childSession)] = normalizeSessionPath(parentSession);
	}

	fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function rememberParentSession(state: ThreadsState, childSession: string, parentSession: string): ThreadsState {
	const next: ThreadsState = {
		enabled: state.enabled === true,
		parentBySession: { ...state.parentBySession },
	};

	next.parentBySession[normalizeSessionPath(childSession)] = normalizeSessionPath(parentSession);
	return next;
}

export function forgetParentSession(state: ThreadsState, childSession: string): ThreadsState {
	const next: ThreadsState = {
		enabled: state.enabled === true,
		parentBySession: { ...state.parentBySession },
	};

	delete next.parentBySession[normalizeSessionPath(childSession)];
	return next;
}

