import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function sh(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(command: string, env?: NodeJS.ProcessEnv): string {
	const result = spawnSync("bash", ["-lc", command], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		maxBuffer: 10 * 1024 * 1024,
	});

	if (result.status !== 0) {
		throw new Error(
			[
				`Command failed: ${command}`,
				`exit=${result.status}`,
				result.stdout ? `stdout:\n${result.stdout}` : "",
				result.stderr ? `stderr:\n${result.stderr}` : "",
			].filter(Boolean).join("\n\n"),
		);
	}

	return result.stdout;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(500);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
	await waitFor(() => fs.existsSync(filePath), timeoutMs, `file ${filePath}`);
}

async function waitForText(filePath: string, pattern: RegExp, timeoutMs: number, label: string): Promise<void> {
	await waitFor(() => fs.existsSync(filePath) && pattern.test(fs.readFileSync(filePath, "utf8")), timeoutMs, label);
}

function writeArtifactList(artifactsDir: string): void {
	const artifactList = fs.readdirSync(artifactsDir).sort();
	fs.writeFileSync(
		path.join(artifactsDir, "artifacts.txt"),
		artifactList.map((name) => path.join(artifactsDir, name)).join("\n") + "\n",
		"utf8",
	);
}

async function main(): Promise<void> {
	const repoDir = process.cwd();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-browser-layout-livedrive-"));
	const projectDir = path.join(root, "project");
	const artifactsDir = path.join(root, "artifacts");
	const parentSession = path.join(root, ".pi", "sessions", "parent.jsonl");
	const childSession = path.join(projectDir, ".pi", "threads", "alpha.jsonl");
	const extensionPath = path.join(repoDir, "index.ts");
	const socketName = `pi-threads-subagents-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const createSessionName = `subagents-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const reopenSessionName = `subagents-reopen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const tmuxEnv = { TERM: "xterm-256color" };
	const tmuxPrefix = `tmux -L ${sh(socketName)} -f /dev/null`;
	const piCommand = `pi --no-extensions -e ${sh(extensionPath)} --no-skills --no-prompt-templates --thinking low --session ${sh(parentSession)}`;
	const parentPrompt = [
		"Use the dispatch tool exactly once to create thread alpha.",
		"In that thread, reply with exactly CHILD-DONE-ALPHA and nothing else.",
		"After the dispatch returns, reply with exactly PARENT-DONE-ALPHA and nothing else.",
	].join(" ");

	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(artifactsDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "README.txt"), "subagents browser layout live-drive repro\n", "utf8");
	fs.writeFileSync(path.join(artifactsDir, "parent-prompt.txt"), `${parentPrompt}\n`, "utf8");
	fs.writeFileSync(path.join(artifactsDir, "pi.command.txt"), `${piCommand}\n`, "utf8");
	fs.writeFileSync(path.join(artifactsDir, "tmux.socket.txt"), `${socketName}\n`, "utf8");

	const runTmux = (args: string) => run(`${tmuxPrefix} ${args}`, tmuxEnv);
	const pane = (sessionName: string) => `${sessionName}:0.0`;
	const hasSession = (sessionName: string) => {
		const result = spawnSync("bash", ["-lc", `${tmuxPrefix} has-session -t ${sh(sessionName)}`], {
			encoding: "utf8",
			env: { ...process.env, ...tmuxEnv },
		});
		return result.status === 0;
	};
	const capture = (sessionName: string, fileName: string) =>
		runTmux(`capture-pane -pt ${sh(pane(sessionName))} -S -220 > ${sh(path.join(artifactsDir, fileName))}`);
	const sendLiteral = (sessionName: string, text: string) => runTmux(`send-keys -t ${sh(pane(sessionName))} -l ${sh(text)}`);
	const sendKey = (sessionName: string, key: string) => runTmux(`send-keys -t ${sh(pane(sessionName))} ${key}`);
	const launchInteractivePi = async (sessionName: string, rawLogName: string) => {
		runTmux(`new-session -d -x 120 -y 24 -s ${sh(sessionName)} 'env TERM=xterm-256color bash -i'`);
		await waitFor(() => hasSession(sessionName), 5000, `tmux session ${sessionName}`);
		runTmux(`pipe-pane -o -t ${sh(pane(sessionName))} ${sh(`cat > ${sh(path.join(artifactsDir, rawLogName))}`)}`);
		sendLiteral(sessionName, "export PATH=\"$HOME/.npm-global/bin:$PATH\"");
		sendKey(sessionName, "Enter");
		sendLiteral(sessionName, `cd ${projectDir}`);
		sendKey(sessionName, "Enter");
		sendLiteral(sessionName, piCommand);
		sendKey(sessionName, "Enter");
		await sleep(8000);
	};

	try {
		await launchInteractivePi(createSessionName, "tmux-create.raw.log");
		capture(createSessionName, "01-create-start.txt");

		sendLiteral(createSessionName, "/threads on");
		sendKey(createSessionName, "Enter");
		await sleep(2000);
		sendKey(createSessionName, "Enter");
		await sleep(4000);
		capture(createSessionName, "02-after-threads-on.txt");

		runTmux(`set-buffer -- ${sh(parentPrompt)}`);
		runTmux(`paste-buffer -t ${sh(pane(createSessionName))}`);
		await sleep(1000);
		sendKey(createSessionName, "Enter");
		await sleep(2000);
		sendKey(createSessionName, "Enter");

		await waitForFile(childSession, 60000);
		await waitForText(parentSession, /"toolName":"dispatch"/, 180000, "completed parent dispatch toolResult");
		await waitForText(parentSession, /PARENT-DONE-ALPHA/, 180000, "parent completion");
		capture(createSessionName, "03-parent-after-dispatch.txt");
		fs.copyFileSync(childSession, path.join(artifactsDir, "03-child-session-final.jsonl"));
		fs.copyFileSync(parentSession, path.join(artifactsDir, "03-parent-session-final.jsonl"));

		runTmux(`kill-session -t ${sh(createSessionName)}`);

		await launchInteractivePi(reopenSessionName, "tmux-reopen.raw.log");
		capture(reopenSessionName, "04-reopen-start.txt");

		sendLiteral(reopenSessionName, "/subagents");
		sendKey(reopenSessionName, "Enter");
		await sleep(5000);
		capture(reopenSessionName, "05-reopened-subagents-browser.txt");

		const browserCapture = fs.readFileSync(path.join(artifactsDir, "05-reopened-subagents-browser.txt"), "utf8");
		assert.match(browserCapture, /^Subagents$/m, "the reopened /subagents browser should open");
		assert.match(browserCapture, /\[alpha\]/, "the reopened browser should show the completed historical child run");
		assert.match(browserCapture, /Selected/, "the browser should still show the selected-detail pane");
		assert.doesNotMatch(
			browserCapture,
			/^Subagents\s+\.\.\.$/m,
			"the browser title should not gain a stray right-edge ellipsis in a wide tmux capture",
		);
		assert.doesNotMatch(
			browserCapture,
			/^Current session only\..*\.\.\.$/m,
			"the browser help line should not gain a stray right-edge ellipsis in a wide tmux capture",
		);
		assert.doesNotMatch(
			browserCapture,
			/^.*\s\.\.\.$/m,
			"wide browser rows should not end in a runtime-added ellipsis when the content itself fits",
		);
	} finally {
		try {
			if (hasSession(createSessionName)) runTmux(`kill-session -t ${sh(createSessionName)}`);
		} catch {
			/* ignore cleanup errors */
		}
		try {
			if (hasSession(reopenSessionName)) runTmux(`kill-session -t ${sh(reopenSessionName)}`);
		} catch {
			/* ignore cleanup errors */
		}
		try {
			runTmux("kill-server");
		} catch {
			/* ignore cleanup errors */
		}
		writeArtifactList(artifactsDir);
		fs.writeFileSync(path.join(artifactsDir, "root.txt"), `${root}\n`, "utf8");
	}

	console.log(`REPRO_ROOT=${root}`);
	console.log(`ARTIFACTS=${artifactsDir}`);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
