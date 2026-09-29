import { describe, expect, it } from "bun:test";
import {
	MAGIC_KEYWORDS,
	renderOrchestrateNotice,
	renderWorkflowNotice,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";

describe("magic keyword registry", () => {
	it("keeps ids and words unique so notice types and settings keys cannot collide", () => {
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.id)).size).toBe(MAGIC_KEYWORDS.length);
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.word)).size).toBe(MAGIC_KEYWORDS.length);
	});
});

describe("orchestrate notice", () => {
	it("is a self-contained system notice carrying the orchestration contract", () => {
		const notice = renderOrchestrateNotice({
			tools: ["read", "task", "edit", "write", "lsp", "bash", "todo"],
		});
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice.endsWith("</system-notice>")).toBe(true);
		expect(notice).toContain("orchestrator");
		// The contract must not retain the slash-command input placeholder.
		expect(notice).not.toContain("$@");
	});

	it("omits tool-budget mentions for tools absent from the session", () => {
		const notice = renderOrchestrateNotice({ tools: ["read"] });
		expect(notice).not.toContain("`task` for dispatch");
		expect(notice).not.toContain("`edit`");
		expect(notice).not.toContain("`write`");
		expect(notice).not.toContain("`lsp diagnostics`");
		expect(notice).not.toContain("via `bash`");
		expect(notice).not.toContain("`todo` for tracking");
	});

	it("does not name edit when only write is available", () => {
		const writeOnly = renderOrchestrateNotice({ tools: ["read", "write"] });
		expect(writeOnly).toContain("with `write`");
		expect(writeOnly).not.toContain("`edit`/`write`");
		expect(writeOnly).not.toContain("with `edit`");
	});

	it("does not name write when only edit is available", () => {
		const editOnly = renderOrchestrateNotice({ tools: ["read", "edit"] });
		expect(editOnly).toContain("with `edit`");
		expect(editOnly).not.toContain("`edit`/`write`");
	});
});

describe("keyword notices under Claude Code", () => {
	// A 2.1.284 surface: `task` is presented as Agent, `wait` is withheld with no
	// TaskOutput in its place, so it is neither in the reachable tools nor the refs.
	const toolRefs = { task: "Agent", read: "Read", write: "Write", edit: "Edit", bash: "Bash", eval: "eval" };
	const tools = ["read", "task", "edit", "write", "bash", "todo", "eval"];

	it("name the presented tools and never the withheld wait", () => {
		const orchestrate = renderOrchestrateNotice({ tools, toolRefs });
		expect(orchestrate).toContain("`Agent` subagents");
		expect(orchestrate).toContain("launch all parallel `Agent` subagents in one message");
		expect(orchestrate).toContain("git via `Bash`");
		for (const omp of ["`wait`", "`edit`", "`write`", "`bash`", "undefined"]) {
			expect(orchestrate).not.toContain(omp);
		}
		// `task` survives only as an agent type (a `subagent_type` value), never as the tool.
		expect(orchestrate.replaceAll("`task`/`sonic`", "")).not.toContain("`task`");
		const workflow = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true, toolRefs });
		expect(workflow).toContain("end your turn: results arrive as notifications");
		expect(workflow).not.toContain("`wait`");
		expect(workflow).not.toContain("undefined");
	});

	it("name TaskOutput where it stands in for wait", () => {
		const withTaskOutput = { ...toolRefs, wait: "TaskOutput" };
		const orchestrate = renderOrchestrateNotice({ tools: [...tools, "wait"], toolRefs: withTaskOutput });
		expect(orchestrate).toContain("Blocked with nothing else to do? Use `TaskOutput`.");
		const workflow = renderWorkflowNotice({
			taskBatch: true,
			scoutAvailable: true,
			evalTools: true,
			toolRefs: withTaskOutput,
		});
		expect(workflow).toContain("call `TaskOutput`");
	});

	it("keep the native text when no refs are given", () => {
		const orchestrate = renderOrchestrateNotice({ tools: [...tools, "wait"] });
		expect(orchestrate).toContain("Blocked with nothing else to do? Use `wait`.");
		expect(orchestrate).toContain("`task` subagents");
		expect(renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true })).toContain(
			"Leave `eval` and call `wait`",
		);
	});
});

describe("workflow notice", () => {
	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true });
		const disabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: false });
		expect(enabled).toContain("Default to `workpool()`");
		expect(enabled).toContain("`@tool`");
		expect(disabled).toContain("Default to `workpool()`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});
});
