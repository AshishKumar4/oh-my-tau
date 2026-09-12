import { describe, expect, test } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const CODEX = getBundledModel("openai-codex", "gpt-6-astra");
const CLAUDE_CODE = getBundledModel("anthropic", "claude-opus-5");

interface StubTool {
	tool: AgentTool;
	calls: Record<string, unknown>[];
}

function stubTool(name: string, respond: (args: Record<string, unknown>) => unknown): StubTool {
	const calls: Record<string, unknown>[] = [];
	const tool: AgentTool = {
		name,
		label: name,
		description: name,
		parameters: {},
		async execute(_id, params): Promise<AgentToolResult> {
			const { i: _intent, ...recorded } = params as Record<string, unknown>;
			calls.push(recorded);
			const result = respond(params as Record<string, unknown>) as {
				text: string;
				details?: Record<string, unknown>;
				images?: { mimeType: string; data: string }[];
			};
			return {
				content: [
					{ type: "text", text: result.text },
					...(result.images ?? []).map(image => ({ type: "image" as const, ...image })),
				],
				details: result.details,
			};
		},
	};
	return { tool, calls };
}
function session(
	model: Model,
	tools: StubTool[],
	options: { asyncJobIds?: readonly string[]; disabled?: readonly string[] } = {},
): ToolSession {
	const disabled = new Set(options.disabled ?? []);
	const registry = new Map(tools.filter(t => !disabled.has(t.tool.name)).map(t => [t.tool.name, t.tool]));
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getActiveModel: () => model,
		getToolForEvalBridge: (name: string) => registry.get(name),
		getEvalBridgeToolNames: () => [...registry.keys()],
		getToolContext: () => undefined,
		asyncJobManager: options.asyncJobIds
			? ({ getJob: (id: string) => (options.asyncJobIds?.includes(id) ? { id } : undefined) } as never)
			: undefined,
	} as unknown as ToolSession;
}

const call = (s: ToolSession, name: string, args: unknown) => callSessionTool(name, args, { session: s });

describe("codex nested exec aliases", () => {
	test("exec_command maps cmd/workdir/yield_time_ms onto bash and returns the vendor shape", async () => {
		const bash = stubTool("bash", () => ({ text: "/tmp/harness-task\n", details: { exitCode: 0 } }));
		const s = session(CODEX, [bash]);

		const out = await call(s, "exec_command", { cmd: "pwd", workdir: "/tmp/harness-task", yield_time_ms: 12000 });
		expect(bash.calls).toEqual([{ command: "pwd", cwd: "/tmp/harness-task", timeout: 12 }]);
		expect(out).toMatchObject({ output: "/tmp/harness-task\n", exit_code: 0 });
		expect(typeof (out as Record<string, unknown>).wall_time_seconds).toBe("number");
	});

	test("exec_command reports session_id when bash backgrounded the command", async () => {
		const bash = stubTool("bash", () => ({
			text: "Backgrounded: bg_7",
			details: { async: { state: "running", jobId: "bg_7" } },
		}));
		const s = session(CODEX, [bash]);

		const out = await call(s, "exec_command", { cmd: "sleep 30" });
		expect(out).toMatchObject({ session_id: "bg_7" });
		expect((out as Record<string, unknown>).exit_code).toBeUndefined();
	});

	test("write_stdin with empty chars polls via hub wait", async () => {
		const hub = stubTool("hub", () => ({ text: "…output…", details: {} }));
		const s = session(CODEX, [hub]);

		const out = await call(s, "write_stdin", { session_id: "bg_2", yield_time_ms: 2000 });
		expect(hub.calls).toEqual([{ op: "wait", ids: ["bg_2"], timeoutMs: 2000 }]);
		expect(out).toMatchObject({ output: "…output…" });
	});

	test("write_stdin with chars to a backgrounded job refuses stdin honestly", async () => {
		const hub = stubTool("hub", () => ({ text: "ok", details: {} }));
		const s = session(CODEX, [hub], { asyncJobIds: ["bg_2"] });

		const error = await call(s, "write_stdin", { session_id: "bg_2", chars: "yes\n" }).catch(e => e);
		expect(error).toBeInstanceOf(ToolError);
		expect(String(error)).toContain("no stdin");
		expect(hub.calls).toEqual([]);
	});

	test("apply_patch forwards the raw patch document to edit", async () => {
		const patch = "*** Begin Patch\n*** Update File: x.py\n@@\n-1\n+2\n*** End Patch";
		const edit = stubTool("edit", () => ({ text: "applied", details: { op: "update" } }));
		const s = session(CODEX, [edit]);

		const out = await call(s, "apply_patch", patch);
		expect(edit.calls).toEqual([{ input: patch }]);
		expect(out).toBe("applied");
	});

	test("view_image reads the file and returns a data URL with the vendor shape", async () => {
		const data = Buffer.from([137, 80, 78, 71]).toString("base64");
		const read = stubTool("read", () => ({
			text: "",
			details: {},
			images: [{ mimeType: "image/png", data }],
		}));
		const s = session(CODEX, [read]);

		const out = (await call(s, "view_image", { path: "/tmp/x.png" })) as Record<string, unknown>;
		expect(out.image_url).toBe(`data:image/png;base64,${data}`);
		expect(out.detail).toBe("high");
		expect(read.calls).toEqual([{ path: "/tmp/x.png" }]);
	});

	test("view_image errors when read returns no image", async () => {
		const read = stubTool("read", () => ({ text: "file contents", details: {} }));
		const s = session(CODEX, [read]);

		const missing = await call(s, "view_image", { path: "/tmp/x.txt" }).catch(e => e);
		expect(missing).toBeInstanceOf(ToolError);
		expect(String(missing)).toContain("no image");
		expect(read.calls).toEqual([{ path: "/tmp/x.txt" }]);
	});

	test("goal aliases map onto goal ops; blocked is a ToolError", async () => {
		const goal = stubTool("goal", () => ({ text: "Goal: demo", details: {} }));
		const s = session(CODEX, [goal]);

		await call(s, "create_goal", { objective: "demo", token_budget: 5000 });
		await call(s, "get_goal", {});
		await call(s, "update_goal", { status: "complete" });
		expect(goal.calls).toEqual([
			{ op: "create", objective: "demo", token_budget: 5000 },
			{ op: "get" },
			{ op: "complete" },
		]);

		const blocked = await call(s, "update_goal", { status: "blocked" }).catch(e => e);
		expect(blocked).toBeInstanceOf(ToolError);
		expect(String(blocked)).toContain("no blocked state");
	});

	test("aliases require an enabled target and never resolve off the codex profile", async () => {
		const bash = stubTool("bash", () => ({ text: "ok", details: {} }));
		const disabled = session(CODEX, [bash], { disabled: ["bash"] });
		const off = session(CLAUDE_CODE, [bash]);

		const e1 = await call(disabled, "exec_command", { cmd: "pwd" }).catch(e => e);
		expect(e1).toBeInstanceOf(ToolError);
		expect(String(e1)).toContain("Unknown tool");

		const e2 = await call(off, "exec_command", { cmd: "pwd" }).catch(e => e);
		expect(e2).toBeInstanceOf(ToolError);
		expect(String(e2)).toContain("Unknown tool");
	});
});
