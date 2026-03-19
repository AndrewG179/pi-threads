import type { ChildProcess } from "node:child_process";

export interface TerminateActorProcessOptions {
	sigtermGraceMs: number;
}

interface ExitSnapshot {
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
}

export interface TerminateActorProcessResult extends ExitSnapshot {
	/**
	 * True when this function had to escalate to SIGKILL.
	 */
	forced: boolean;
	/**
	 * The final signal this function sent (`SIGTERM`, `SIGKILL`, or `null` when
	 * the process had already exited before termination was requested).
	 */
	signal: "SIGTERM" | "SIGKILL" | null;
}

function getExitSnapshot(child: ChildProcess): ExitSnapshot | null {
	if (child.exitCode === null && child.signalCode === null) return null;
	return {
		exitCode: child.exitCode,
		exitSignal: child.signalCode,
	};
}

function waitForExit(child: ChildProcess): Promise<ExitSnapshot> {
	const exited = getExitSnapshot(child);
	if (exited) return Promise.resolve(exited);

	return new Promise<ExitSnapshot>((resolve) => {
		const onExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
			cleanup();
			resolve({ exitCode, exitSignal });
		};

		const cleanup = () => {
			child.off("exit", onExit);
		};

		child.once("exit", onExit);

		const racedExit = getExitSnapshot(child);
		if (racedExit) {
			cleanup();
			resolve(racedExit);
		}
	});
}

function waitForExitOrTimeout(child: ChildProcess, timeoutMs: number): Promise<ExitSnapshot | null> {
	const exited = getExitSnapshot(child);
	if (exited) return Promise.resolve(exited);

	return new Promise<ExitSnapshot | null>((resolve) => {
		let settled = false;

		const cleanup = () => {
			clearTimeout(timer);
			child.off("exit", onExit);
		};

		const onExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ exitCode, exitSignal });
		};

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(null);
		}, Math.max(0, timeoutMs));

		child.once("exit", onExit);

		const racedExit = getExitSnapshot(child);
		if (racedExit && !settled) {
			settled = true;
			cleanup();
			resolve(racedExit);
		}
	});
}

const PRE_SIGTERM_SETTLE_MS = 25;

/**
 * Gracefully terminate an actor process.
 *
 * Behavior:
 * 1. Allow a tiny startup settle window (for just-spawned processes to install
 *    signal handlers).
 * 2. Send SIGTERM.
 * 3. Wait up to `sigtermGraceMs` for real process exit (via exit code/signal).
 * 4. If still running, escalate to SIGKILL and wait for real exit.
 *
 * Important: this does not use `child.killed` to infer exit.
 */
export async function terminateActorProcess(
	child: ChildProcess,
	{ sigtermGraceMs }: TerminateActorProcessOptions,
): Promise<TerminateActorProcessResult> {
	const exitedBeforeTermination = getExitSnapshot(child);
	if (exitedBeforeTermination) {
		return {
			forced: false,
			signal: null,
			...exitedBeforeTermination,
		};
	}

	const settleMs = Math.min(Math.max(0, sigtermGraceMs), PRE_SIGTERM_SETTLE_MS);
	if (settleMs > 0) {
		const exitedDuringSettle = await waitForExitOrTimeout(child, settleMs);
		if (exitedDuringSettle) {
			return {
				forced: false,
				signal: null,
				...exitedDuringSettle,
			};
		}
	}

	child.kill("SIGTERM");

	const exitedAfterSigterm = await waitForExitOrTimeout(child, sigtermGraceMs);
	if (exitedAfterSigterm) {
		return {
			forced: false,
			signal: "SIGTERM",
			...exitedAfterSigterm,
		};
	}

	const racedExitAfterTimeout = getExitSnapshot(child);
	if (racedExitAfterTimeout) {
		return {
			forced: false,
			signal: "SIGTERM",
			...racedExitAfterTimeout,
		};
	}

	const sentSigkill = child.kill("SIGKILL");
	const finalExit = await waitForExit(child);

	if (sentSigkill) {
		return {
			forced: true,
			signal: "SIGKILL",
			...finalExit,
		};
	}

	return {
		forced: false,
		signal: "SIGTERM",
		...finalExit,
	};
}
