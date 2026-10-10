import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which, isRecord, readLines } from "@oh-my-pi/pi-utils";

const python = Bun.env.PYTHON ?? $which("python3") ?? $which("python");
const runner = path.resolve(import.meta.dir, "../../../src/eval/py/runner.py");

async function execute(code: string): Promise<{ output: string; errors: string[]; status: string }> {
	if (!python) throw new Error("Python is required for runner verification");
	const child = Bun.spawn([python, "-u", runner], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
	});
	const stderr = new Response(child.stderr).text();
	let output = "";
	const errors: string[] = [];
	try {
		await child.stdin.write(`${JSON.stringify({ id: "probe", code })}\n`);
		await child.stdin.flush();
		for await (const line of readLines(child.stdout)) {
			const frame = JSON.parse(new TextDecoder().decode(line));
			if (!isRecord(frame)) throw new Error("Invalid runner frame");
			if (frame.type === "stdout" && typeof frame.data === "string") output += frame.data;
			if (frame.type === "error" && typeof frame.evalue === "string") errors.push(frame.evalue);
			if (frame.type === "done" && frame.id === "probe" && typeof frame.status === "string") {
				return { output, errors, status: frame.status };
			}
		}
		throw new Error(`Runner exited before completing its request: ${await stderr}`);
	} finally {
		child.kill();
		await child.exited;
		await stderr;
	}
}

describe.skipIf(!python)("Python quoted source and real magic execution", () => {
	it("preserves raw generated text, interpolated strings and quoted closing delimiters", async () => {
		const payload = "%.o: %.c\n![image](plot.png)\n!literal\n%pwd\n%%bash\nvalue = %pwd";
		const result = await execute(
			[
				`source = r"""${payload}"""`,
				`assert source == ${JSON.stringify(payload)}`,
				"value = 7",
				'source = f"""first {value}\n%pwd\n!literal\n"""',
				'assert source == "first 7\\n%pwd\\n!literal\\n"',
				"import io",
				"output = io.StringIO()",
				'output.write("""\nbool ok;\nok = !done;""")',
				'assert output.getvalue() == "\\nbool ok;\\nok = !done;"',
				'print("preserved")',
			].join("\n"),
		);
		expect(result.errors).toEqual([]);
		expect(result.status).toBe("ok");
		expect(result.output.trim()).toBe("preserved");
	});

	it("executes real indented and assigned magics without scanning shell quotes as Python", async () => {
		const result = await execute(
			[
				"import os",
				"!echo \"'''\"",
				'source = """%pwd\n!literal\n"""',
				'assert source == "%pwd\\n!literal\\n"',
				"cwd = %pwd",
				"assert cwd == os.getcwd()",
				"out = !echo assigned",
				'assert out == ["assigned"]',
				"if True:",
				"    %pwd",
				"    !echo indented",
				'print("completed")',
				"%%bash",
				"printf cell-completed",
			].join("\n"),
		);
		expect(result.errors).toEqual([]);
		expect(result.status).toBe("ok");
		expect(result.output).toContain("indented");
		expect(result.output).toContain("cell-completed");
	});

	it("rejects unterminated Python strings without executing embedded shell commands", async () => {
		const result = await execute('source = """\n!echo must-not-run\n');
		expect(result.status).toBe("error");
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.output).toBe("");
	});
});
