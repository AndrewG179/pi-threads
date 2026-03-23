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

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(filePath)) return;
		await sleep(500);
	}
	throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function main(): Promise<void> {
	const repoDir = process.cwd();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-parent-completion-repro-"));
	const projectDir = path.join(root, "project");
	const artifactsDir = path.join(root, "artifacts");
	const parentSession = path.join(root, ".pi", "sessions", "parent.jsonl");
	const childSession = path.join(projectDir, ".pi", "threads", "slow1.jsonl");
	const sessionName = `subagents-parent-completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const extensionPath = path.join(repoDir, "index.ts");
	const paneCommand = `export PATH="$HOME/.npm-global/bin:$PATH"; which pi; cd ${sh(projectDir)}; exec pi --no-extensions -e ${sh(extensionPath)} --no-skills --no-prompt-templates --thinking low --session ${sh(parentSession)}`;

	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(artifactsDir, { recursive: true });
	fs.mkdirSync(path.dirname(parentSession), { recursive: true });
	fs.writeFileSync(path.join(projectDir, "README.txt"), "parent completion livedrive repro\n", "utf8");
	fs.writeFileSync(path.join(artifactsDir, "pi.command.txt"), `${paneCommand}\n`, "utf8");

	const prompt = [
		"Use dispatch exactly once to create thread slow1. In that thread, use the shell tool to run exactly: bash -lc 'for i in 1 2 3 4 5 6; do echo LIVE-STEP:$i; sleep 5; done'.",
		"Wait for it to finish. Then, in that thread, reply with exactly CHILD-FINISHED-SLOW1 and nothing else.",
		"After the dispatch returns to you, reply with exactly PARENT-FINISHED-SLOW1 and nothing else.",
	].join(" ");
	fs.writeFileSync(path.join(artifactsDir, "input-parent-dispatch.txt"), `${prompt}\n`, "utf8");

	const capture = (fileName: string) =>
		run(`tmux capture-pane -pt ${sh(`${sessionName}:0.0`)} -S -220 > ${sh(path.join(artifactsDir, fileName))}`);
	const sendLiteral = (text: string) => run(`tmux send-keys -t ${sh(`${sessionName}:0.0`)} -l ${sh(text)}`);
	const sendKey = (key: string) => run(`tmux send-keys -t ${sh(`${sessionName}:0.0`)} ${key}`);

	try {
		run(`tmux new-session -d -s ${sh(sessionName)} ${sh(`bash -lc ${sh(paneCommand)}`)}`);
		run(`tmux pipe-pane -o -t ${sh(`${sessionName}:0.0`)} ${sh(`cat > ${sh(path.join(artifactsDir, "tmux-pane.raw.log"))}`)}`);

		await sleep(8000);
		capture("01-start.txt");

		fs.writeFileSync(path.join(artifactsDir, "input-threads-on.txt"), "/threads on\n", "utf8");
		sendLiteral("/threads on");
		sendKey("Enter");
		await sleep(2000);
		sendKey("Enter");
		await sleep(4000);
		capture("02-after-threads-on.txt");

		run(`tmux set-buffer -- ${sh(prompt)}`);
		run(`tmux paste-buffer -t ${sh(`${sessionName}:0.0`)}`);
		await sleep(1000);
		sendKey("Enter");
		await sleep(2000);
		sendKey("Enter");
		await sleep(6000);
		capture("03-parent-dispatch-started.txt");
		await waitForFile(childSession, 30000);
		fs.copyFileSync(childSession, path.join(artifactsDir, "03b-slow1-thread-inflight-snapshot.jsonl"));

		fs.writeFileSync(path.join(artifactsDir, "input-subagents-open-browser.txt"), "/subagents\n", "utf8");
		sendLiteral("/subagents");
		sendKey("Enter");
		await sleep(5000);
		capture("04-subagents-browser-inflight.txt");

		const browserCapture = fs.readFileSync(path.join(artifactsDir, "04-subagents-browser-inflight.txt"), "utf8");
		assert.match(browserCapture, /^Subagents$/m, "the /subagents browser should open");
		assert.match(browserCapture, /\[slow1\]/, "the live browser should show the in-flight child before any completed parent dispatch toolResult exists");

		sendKey("Enter");
		await sleep(36000);
		capture("05-subagent-inspector-after-wait.txt");

		const inspectorView = fs.readFileSync(path.join(artifactsDir, "05-subagent-inspector-after-wait.txt"), "utf8");
		assert.match(inspectorView, /Subagent \[slow1\]/, "Enter should open the same-session inspector for the selected child");
		assert.match(inspectorView, /LIVE-STEP:6/, "the child should keep running while the inspector is open");
		assert.match(inspectorView, /CHILD-FINISHED-SLOW1/, "the child should finish while the inspector is open");

		sendKey("Escape");
		await sleep(1000);
		sendKey("Escape");
		await sleep(12000);
		capture("06-parent-after-browser-close.txt");
		await sleep(20000);
		capture("07-parent-after-extra-wait.txt");

		fs.copyFileSync(childSession, path.join(artifactsDir, "08-child-session-final.jsonl"));
		fs.copyFileSync(parentSession, path.join(artifactsDir, "09-parent-session-final.jsonl"));

		const childSessionText = fs.readFileSync(childSession, "utf8");
		assert.match(childSessionText, /"role":"toolResult"/, "the child session should record the shell toolResult");
		assert.match(childSessionText, /CHILD-FINISHED-SLOW1/, "the child session should record the final child completion");

		const parentSessionText = fs.readFileSync(parentSession, "utf8");
		assert.match(
			parentSessionText,
			/"role":"toolResult"/,
			"after live same-session inspection, the parent dispatch should still record its final dispatch toolResult",
		);
		assert.match(
			parentSessionText,
			/PARENT-FINISHED-SLOW1/,
			"after the child finishes, the parent should still record its own final completion message",
		);
	} finally {
		try {
			run(`tmux kill-session -t ${sh(sessionName)}`);
		} catch {
			/* ignore cleanup errors */
		}

		const artifactList = fs.readdirSync(artifactsDir).sort();
		fs.writeFileSync(
			path.join(artifactsDir, "artifacts.txt"),
			artifactList.map((name) => path.join(artifactsDir, name)).join("\n") + "\n",
			"utf8",
		);
		fs.writeFileSync(path.join(artifactsDir, "root.txt"), `${root}\n`, "utf8");
	}

	console.log(`REPRO_ROOT=${root}`);
	console.log(`ARTIFACTS=${artifactsDir}`);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
