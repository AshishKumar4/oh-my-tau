import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// oh-my-tau's install.sh must never select an upstream distribution. It runs in a
// sandbox whose PATH shadows every download, package-manager and VCS tool with a
// recorder, against a fake build service that logs any request it gets.

const repoRoot = path.join(import.meta.dir, "..");
const INTERCEPTED = ["curl", "wget", "bun", "npm", "npx", "pnpm", "yarn", "git", "brew", "mise", "tar", "unzip"];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function sandbox(): Promise<{ binDir: string; log: string; home: string; installDir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-install-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const binDir = path.join(dir, "bin");
	const log = path.join(dir, "calls.log");
	await fs.mkdir(binDir);
	for (const tool of INTERCEPTED) {
		const stub = path.join(binDir, tool);
		await Bun.write(stub, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 0\n`);
		await fs.chmod(stub, 0o755);
	}
	return { binDir, log, home: path.join(dir, "home"), installDir: path.join(dir, "install") };
}

function startBuildService(): { url: string; requests: string[] } {
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			requests.push(new URL(request.url).pathname);
			return new Response("{}", { headers: { "content-type": "application/json" } });
		},
	});
	cleanups.push(() => server.stop(true));
	return { url: `http://127.0.0.1:${server.port}`, requests };
}

async function runInstall(args: string[], options: { piped?: boolean } = {}) {
	const box = await sandbox();
	const service = startBuildService();
	const script = path.join(repoRoot, "scripts", "install.sh");
	// `curl … | sh -s -- <args>` reads the script from stdin.
	const command = options.piped ? ["sh", "-s", "--", ...args] : ["sh", script, ...args];
	const proc = Bun.spawn(command, {
		cwd: box.home.replace(/home$/, ""),
		env: {
			PATH: `${box.binDir}:/usr/bin:/bin`,
			HOME: box.home,
			PI_INSTALL_DIR: box.installDir,
			PI_BUILD_URL: service.url,
		},
		stdin: options.piped ? Bun.file(script) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const calls = (await Bun.file(box.log).exists()) ? await Bun.file(box.log).text() : "";
	const installed = await fs.exists(box.installDir);
	return { exitCode, stdout, stderr, calls, requests: service.requests, installed };
}

describe.skipIf(process.platform === "win32")("oh-my-tau install.sh", () => {
	test.each([
		["no options", []],
		["--binary", ["--binary"]],
		["--source", ["--source"]],
		["--binary --ref", ["--binary", "--ref", "v18.11.2"]],
		["--source -r", ["--source", "-r", "main"]],
	])("refuses with %s and selects no upstream distribution", async (_label, args) => {
		for (const piped of [false, true]) {
			const result = await runInstall(args, { piped });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("./scripts/install-harness.sh");
			expect(result.stdout).toBe("");
			// No download, package manager or git ran, the build service saw no request,
			// and nothing was installed.
			expect(result.calls).toBe("");
			expect(result.requests).toEqual([]);
			expect(result.installed).toBe(false);
		}
	});

	test("holds no URL it could fetch an upstream distribution from", async () => {
		const text = await Bun.file(path.join(repoRoot, "scripts", "install.sh")).text();
		expect(text).not.toMatch(/https?:\/\//);
	});
});
