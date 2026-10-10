import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";

describe.skipIf(process.platform === "win32")("regular-file boundaries", () => {
	it("rejects owned FIFOs and their aliases across write, SQLite and LSP without blocking", async () => {
		using directory = TempDir.createSync("@pi-special-file-");
		const fifo = directory.join("input.db");
		const alias = directory.join("alias.db");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		await fs.symlink(fifo, alias);
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
		expect((await fs.stat(fifo)).isFIFO()).toBe(true);
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
	}, 20_000);
});
