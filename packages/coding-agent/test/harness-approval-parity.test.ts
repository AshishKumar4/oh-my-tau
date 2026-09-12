import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Model, validateToolArguments } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { harnessToolBinding } from "@oh-my-pi/pi-coding-agent/harness/manifest";
import { type ApprovalMode, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { toolWireSchema, validateToolArguments as validateArgs } from "@oh-my-pi/pi-ai";

const CLAUDE_CODE_MODEL = getBundledModel("anthropic", "claude-opus-5");

interface BashPatternRule {
	match: string;
	approval: "allow" | "deny" | "prompt";
}

function toolSession(bashPatterns: readonly BashPatternRule[] = [], model?: Model, cwd = os.tmpdir()): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getActiveModel: () => model,
		settings: {
			get(key: string) {
				if (key === "bash.patterns") return bashPatterns;
				if (key === "bash.allowCompoundCommands") return false;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getShellConfig() {
				return { shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined };
			},
		},
	} as unknown as ToolSession;
}

function harnessBashArgs(command: string): Record<string, unknown> {
	return { command, description: "Run a command", timeout: 120_000, run_in_background: false };
}

function call(args: Record<string, unknown>) {
	return { type: "toolCall" as const, id: "call-1", name: "Write", arguments: args };
}

const MODES: readonly ApprovalMode[] = ["always-ask", "write", "yolo"];

describe("approval parity under a harness rename", () => {
	it("resolves identical decisions for harness-shaped and omp-shaped bash payloads", () => {
		const tool = new BashTool(toolSession());
		for (const command of ["ls -la", "rm -rf /", "sudo rm /etc/passwd"]) {
			for (const mode of MODES) {
				const omp = resolveApproval(tool, { command }, mode);
				const harness = resolveApproval(tool, harnessBashArgs(command), mode);
				expect(harness).toEqual(omp);
			}
		}
		expect(resolveApproval(tool, { command: "rm -rf /" }, "write")).toEqual({
			policy: "prompt",
			tier: "exec",
			override: true,
			source: "tool",
			reason: "Critical pattern detected",
		});
		expect(resolveApproval(tool, { command: "ls -la" }, "write").policy).toBe("prompt");
		expect(resolveApproval(tool, { command: "ls -la" }, "write").override).toBe(false);
	});

	it("keeps a user deny pattern firing on the harness-shaped payload", () => {
		const tool = new BashTool(toolSession([{ match: "rm -rf*", approval: "deny" }]));
		for (const mode of MODES) {
			const harness = resolveApproval(tool, harnessBashArgs("rm -rf /"), mode);
			expect(harness).toEqual(resolveApproval(tool, { command: "rm -rf /" }, mode));
			expect(harness.policy).toBe("deny");
		}
	});

	it("keys user approval policies on the internal name, never the harness wire name", () => {
		const tool = new BashTool(toolSession());
		expect(harnessToolBinding("claude-code", "bash")?.wireName).toBe("Bash");
		expect(resolveApproval(tool, { command: "ls" }, "yolo", { bash: "deny" }).policy).toBe("deny");
		expect(resolveApproval(tool, { command: "ls" }, "yolo", { Bash: "deny" }).policy).toBe("allow");
	});

	it("computes the write tier from the vendor payload under the claude-code profile", () => {
		const profiled = new WriteTool(toolSession([], CLAUDE_CODE_MODEL));
		const vendorShaped = resolveApproval(profiled, { file_path: "xd://debug", content: "{}" }, "write");
		expect(vendorShaped).toEqual(
			resolveApproval(new WriteTool(toolSession()), { path: "xd://debug", content: "{}" }, "write"),
		);
		expect(vendorShaped.tier).toBe("exec");
		expect(vendorShaped.policy).toBe("prompt");
		expect(
			resolveApproval(new WriteTool(toolSession()), { file_path: "xd://debug", content: "{}" }, "write"),
		).toMatchObject({ tier: "write", policy: "allow" });
	});

	it("validates each write spelling only on the surface that declares it", () => {
		expect(harnessToolBinding("claude-code", "write")?.wireName).toBe("Write");
		const profiled = new WriteTool(toolSession([], CLAUDE_CODE_MODEL));
		expect(validateToolArguments(profiled, call({ file_path: "/tmp/x", content: "hi" }))).toMatchObject({
			file_path: "/tmp/x",
			content: "hi",
		});
		expect(() => validateToolArguments(profiled, call({ path: "/tmp/x", content: "hi" }))).toThrow();
		const native = new WriteTool(toolSession());
		expect(() => validateToolArguments(native, call({ file_path: "/tmp/x", content: "hi" }))).toThrow();
		expect(validateToolArguments(native, call({ path: "/tmp/x", content: "hi" }))).toMatchObject({
			path: "/tmp/x",
			content: "hi",
		});
	});

	it("executes the vendor Write payload through omp's write", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-write-"));
		try {
			const tool = new WriteTool(toolSession([], CLAUDE_CODE_MODEL, dir));
			const target = path.join(dir, "out.txt");
			const result = await tool.execute("call-1", { file_path: target, content: "hello\n" });
			expect(result.isError).toBeUndefined();
			expect(await Bun.file(target).text()).toBe("hello\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("presents Claude Code's Bash fields under the profile and bridges timeout from milliseconds", async () => {
		const tool = new BashTool(toolSession([], CLAUDE_CODE_MODEL));
		const native = new BashTool(toolSession());
		const wire = validateArgs(tool, {
			type: "toolCall",
			id: "c",
			name: "Bash",
			arguments: { command: "echo hi", timeout: 900_000, description: "Print hi", run_in_background: false },
		});
		expect(wire).toMatchObject({ command: "echo hi", timeout: 900_000 });
		const schemaOf = (candidate: BashTool) =>
			toolWireSchema({ name: "bash", description: "", parameters: candidate.parameters }) as {
				properties: Record<string, { description?: string }>;
			};
		const schema = schemaOf(tool);
		expect(Object.keys(schema.properties)).toEqual([
			"command",
			"timeout",
			"description",
			"run_in_background",
			"dangerouslyDisableSandbox",
		]);
		expect(schema.properties.timeout?.description).toMatch(/milliseconds/);
		expect(schemaOf(native).properties.timeout?.description).toMatch(/seconds/);
		expect(tool.intent({ command: "echo hi", description: "Print hi" })).toBe("Print hi");
		const result = await tool.execute("c", { command: "echo hi", timeout: 900_000 });
		expect(result.isError).toBeFalsy();
		expect(result.details?.timeoutSeconds).toBe(900);
		expect(result.details?.requestedTimeoutSeconds).toBeUndefined();
		const nativeResult = await native.execute("c", { command: "echo hi", timeout: 900 });
		expect(nativeResult.details?.timeoutSeconds).toBe(900);
		const disabled = await tool.execute("c", { command: "echo hi", timeout: 0 });
		expect(disabled.details?.timeoutDisabled).toBe(true);
		await expect(tool.execute("c", { command: "sleep 0", run_in_background: true })).rejects.toThrow(
			/run_in_background/,
		);
	});

	it("rejects Bash.dangerouslyDisableSandbox by name instead of dropping it", async () => {
		const tool = new BashTool(toolSession([], CLAUDE_CODE_MODEL));
		await expect(tool.execute("c", { command: "echo hi", dangerouslyDisableSandbox: true })).rejects.toThrow(
			/dangerouslyDisableSandbox/,
		);
	});

	it("presents Claude Code's Read fields under the profile and maps offset/limit onto a line selector", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-read-"));
		try {
			const target = path.join(dir, "lines.txt");
			await Bun.write(target, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
			const tool = new ReadTool(toolSession([], CLAUDE_CODE_MODEL, dir));
			const schema = toolWireSchema({ name: "read", description: "", parameters: tool.parameters }) as {
				properties: Record<string, unknown>;
			};
			expect(Object.keys(schema.properties)).toEqual(["file_path", "offset", "limit", "pages"]);
			expect(() => validateArgs(tool, call({ path: target }))).toThrow();

			const native = new ReadTool(toolSession([], undefined, dir));
			const text = async (
				reader: ReadTool,
				args: { file_path: string; offset?: number; limit?: number } | { path: string },
			): Promise<string[]> => {
				const result = await reader.execute("c", args);
				return result.content
					.flatMap(block => (block.type === "text" ? block.text.split("\n") : []))
					.filter(line => !line.startsWith("["))
					.map(line => line.replace(/^(\d+:|\s*\d+\t)/, ""));
			};
			// The vendor's `Read` returns exactly the requested lines in `cat -n`
			// shape; omp's native read pads a range with context, so compare
			// against the native raw (unpadded) window.
			const window = await text(tool, { file_path: target, offset: 3, limit: 2 });
			expect(window).toEqual(["line3", "line4"]);
			expect(window).toEqual(await text(native, { path: `${target}:raw:3+2` }));
			expect(await text(tool, { file_path: target, offset: 9 })).toEqual(["line9", "line10"]);
			expect(await text(tool, { file_path: target, limit: 1 })).toEqual(["line1"]);
			expect(await text(tool, { file_path: target })).toEqual(await text(native, { path: `${target}:raw` }));

			await expect(tool.execute("c", { file_path: target, pages: "1-2" })).rejects.toThrow(/Read\.pages/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("computes the read tier from the vendor payload under the claude-code profile", () => {
		const profiled = new ReadTool(toolSession([], CLAUDE_CODE_MODEL));
		const native = new ReadTool(toolSession());
		expect(resolveApproval(profiled, { file_path: "ssh://box/etc/hosts" }, "write")).toEqual(
			resolveApproval(native, { path: "ssh://box/etc/hosts" }, "write"),
		);
		expect(resolveApproval(profiled, { file_path: "ssh://box/etc/hosts" }, "write").tier).toBe("exec");
		expect(resolveApproval(profiled, { file_path: "/tmp/x" }, "write").tier).toBe("read");
	});
});
