import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { hasFsCode, removeWithRetries, Snowflake, TempDir } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

/**
 * Write `target` in a child process. A regression blocks the child's main thread in native code,
 * where neither an in-process timer nor SIGTERM can reach it, so the child is SIGKILLed instead.
 */
async function writeInChild(
	target: string,
	cwd: string,
): Promise<{ code: number | null; signal: string | null; output: string }> {
	const script = `
		import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
		import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
		const tool = new WriteTool({ cwd: ${JSON.stringify(cwd)}, settings: Settings.isolated() });
		try {
			await tool.execute("special-write", { path: ${JSON.stringify(target)}, content: "blocked\\n" });
			console.log("RESOLVED");
		} catch (error) {
			console.log(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	`;
	const child = Bun.spawn({
		cmd: [process.execPath, "--eval", script],
		cwd: path.resolve(import.meta.dir, "../.."),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// Generous for slow CI: a passing child exits as soon as the write is refused.
		timeout: 10_000,
		killSignal: "SIGKILL",
	});
	const code = await child.exited;
	const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
	return { code, signal: child.signalCode, output };
}

/** Release a reader without blocking if no read is still waiting. */
function releaseFifoReader(fifo: string): void {
	try {
		fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
	} catch (error) {
		if (!hasFsCode(error, "ENXIO")) throw error;
	}
}

describe.skipIf(process.platform === "win32")("write on non-regular files", () => {
	let testDir: string;
	let fifo: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `write-special-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		fifo = path.join(testDir, "input.fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("rejects an existing FIFO before a main-thread file open can block", async () => {
		const result = await writeInChild(fifo, testDir);

		expect(result.signal).toBeNull();
		expect(result.code).toBe(1);
		expect(result.output).toContain("it is a FIFO");
	}, 30_000);

	it("rejects a FIFO used as a SQLite database without sniffing its header", async () => {
		const sqlitePath = path.join(testDir, "database.db");
		fs.renameSync(fifo, sqlitePath);
		// The SQLite sniff runs asynchronously; keep the test runner's event loop free to time it out.
		const pending = new WriteTool(createSession(testDir))
			.execute("sqlite-fifo", {
				path: `${sqlitePath}:users`,
				content: "{ name: 'Ada' }",
			})
			.then(
				() => "RESOLVED" as const,
				(error: unknown) => error,
			);
		const outcome = await Promise.race([pending, Bun.sleep(1500).then(() => "HUNG" as const)]);
		if (outcome === "HUNG") {
			// Let the released write finish inside testDir so afterEach removes whatever it creates.
			releaseFifoReader(sqlitePath);
			await pending;
		}

		expect(outcome).toBeInstanceOf(ToolError);
		expect(outcome).toHaveProperty("message", expect.stringContaining("it is a FIFO"));
	});

	it("rejects /dev/null instead of treating a character device as a writable file", async () => {
		await expect(
			new WriteTool(createSession(testDir)).execute("null-device", { path: "/dev/null", content: "blocked\n" }),
		).rejects.toHaveProperty("message", expect.stringContaining("it is a character device"));
	});
});

describe.skipIf(process.platform === "win32")("regular-file boundaries", () => {
	it("rejects owned FIFOs and their aliases across write, SQLite and LSP without blocking", async () => {
		using directory = TempDir.createSync("@pi-special-file-");
		const fifo = directory.join("input.db");
		const alias = directory.join("alias.db");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		fs.symlinkSync(fifo, alias);
		const script = `
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { readTextFromDisk, readLocationContext } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { applyTextEdits } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import { BiomeClient } from "@oh-my-pi/pi-coding-agent/lsp/clients/biome-client";
const cwd = ${JSON.stringify(directory.path())};
const paths = ${JSON.stringify([fifo, alias])};
const session = { cwd, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings: Settings.isolated({ "lsp.enabled": false }), enableLsp: false };
const writer = new WriteTool(session);
const biome = new BiomeClient({ command: "must-not-run", fileTypes: ["ts"], rootMarkers: [] }, cwd);
let rejected = 0;
for (const target of paths) {
  for (const operation of [
    () => writer.execute("plain", { path: target, content: "blocked" }),
    () => writer.execute("sqlite", { path: target + ":users", content: "{name:'Ada'}" }),
    () => readTextFromDisk(target),
    () => applyTextEdits(target, []),
    () => biome.format(target, "blocked"),
  ]) {
    try { await operation(); throw new Error("Special target was accepted"); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("FIFO")) throw error; rejected++; }
  }
  if ((await readLocationContext(target, 1)).length !== 0) throw new Error("Expected no decorative file context");
}
const normal = cwd + "/normal.txt";
await writer.execute("normal", { path: normal, content: "normal content\\n" });
if (await readTextFromDisk(normal) !== "normal content\\n") throw new Error("Ordinary write/read failed");
console.log(JSON.stringify({ rejected, normal: true }));
`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: process.cwd(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 15_000,
			killSignal: "SIGKILL",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		expect(child.signalCode).toBeNull();
		expect(JSON.parse(stdout)).toEqual({ rejected: 10, normal: true });
		expect(fs.statSync(fifo).isFIFO()).toBe(true);
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
	}, 20_000);
});
