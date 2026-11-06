import { describe, expect, it } from "bun:test";
import {
	MAGIC_KEYWORDS,
	renderOrchestrateNotice,
	renderWorkflowNotice,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";

/** Workflow-notice inputs with every eval backend on and no per-call models. */
const WORKFLOW_BASE = {
	taskBatch: true,
	scoutAvailable: true,
	evalTools: true,
	py: true,
	js: true,
	freshAgents: false,
	perCallModel: false,
};

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
	// A 2.1.284 surface: `task` is presented as Agent and, with no TaskOutput in
	// its place, `wait` as itself.
	const toolRefs = {
		task: "Agent",
		read: "Read",
		write: "Write",
		edit: "Edit",
		bash: "Bash",
		eval: "eval",
		wait: "wait",
	};
	const tools = ["read", "task", "edit", "write", "bash", "todo", "eval", "wait"];

	it("name the presented tools", () => {
		const orchestrate = renderOrchestrateNotice({ tools, toolRefs });
		expect(orchestrate).toContain("`Agent` subagents");
		expect(orchestrate).toContain("launch all parallel `Agent` subagents in one message");
		expect(orchestrate).toContain("git via `Bash`");
		expect(orchestrate).toContain("Blocked with nothing else to do? Use `wait`.");
		for (const omp of ["`edit`", "`write`", "`bash`", "undefined"]) {
			expect(orchestrate).not.toContain(omp);
		}
		expect(orchestrate).toContain("10. Right-size offload: `Agent` only for substantial");
		expect(orchestrate).toContain("- `Agent` Target/Change/Acceptance scaffolding");
		expect(orchestrate).not.toContain("`task`");
		const workflow = renderWorkflowNotice({ ...WORKFLOW_BASE, toolRefs });
		expect(workflow).toContain("call the `wait` tool");
		expect(workflow).not.toContain("end your turn");
		expect(workflow).not.toContain("undefined");
	});

	it("tell a session with no wait tool to end its turn", () => {
		const noWait = { task: "Agent", read: "Read", write: "Write", edit: "Edit", bash: "Bash", eval: "eval" };
		const orchestrate = renderOrchestrateNotice({ tools: tools.filter(tool => tool !== "wait"), toolRefs: noWait });
		expect(orchestrate).not.toContain("`wait`");
		const workflow = renderWorkflowNotice({ ...WORKFLOW_BASE, toolRefs: noWait });
		expect(workflow).toContain("end your turn: results arrive as notifications");
		expect(workflow).not.toContain("`wait`");
	});

	it("name TaskOutput where it stands in for wait", () => {
		const withTaskOutput = { ...toolRefs, wait: "TaskOutput" };
		const orchestrate = renderOrchestrateNotice({ tools, toolRefs: withTaskOutput });
		expect(orchestrate).toContain("Blocked with nothing else to do? Use `TaskOutput`.");
		const workflow = renderWorkflowNotice({ ...WORKFLOW_BASE, toolRefs: withTaskOutput });
		expect(workflow).toContain("call the `TaskOutput` tool");
	});

	it("keep the native text when no refs are given", () => {
		const orchestrate = renderOrchestrateNotice({ tools });
		expect(orchestrate).toContain("Blocked with nothing else to do? Use `wait`.");
		expect(orchestrate).toContain("`task` subagents");
		expect(orchestrate).toContain("10. Right-size offload: `task` only for substantial");
		expect(orchestrate).toContain("- `task` Target/Change/Acceptance scaffolding");
		expect(renderWorkflowNotice(WORKFLOW_BASE)).toContain("Leave `eval` and call the `wait` tool");
	});
});

describe("workflow notice", () => {
	const base = WORKFLOW_BASE;

	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice(base);
		const disabled = renderWorkflowNotice({ ...base, evalTools: false });
		expect(enabled).toContain("Default to `workpool()`");
		expect(enabled).toContain("`@tool`");
		expect(disabled).toContain("Default to `workpool()`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});

	it("describes the pool dispatch mode the session will actually use", () => {
		const reused = renderWorkflowNotice(base);
		const fresh = renderWorkflowNotice({ ...base, freshAgents: true });
		expect(reused).toContain("keep-alive workers");
		expect(fresh).toContain("single-item agents");
		expect(fresh).not.toContain("keep-alive");
		expect(reused).not.toContain("single-item");
	});

	it("shows only the active eval runtime's call forms", () => {
		const pyOnly = renderWorkflowNotice({ ...base, js: false });
		const jsOnly = renderWorkflowNotice({ ...base, py: false });
		const both = renderWorkflowNotice(base);

		expect(pyOnly).toContain("schema_mode=None");
		expect(pyOnly).not.toContain("```js");
		expect(pyOnly).not.toContain("raiseErrors");
		expect(pyOnly).not.toContain("JS:");

		expect(jsOnly).toContain("await workpool(");
		expect(jsOnly).toContain("schemaMode?");
		expect(jsOnly).not.toContain("```python");
		expect(jsOnly).not.toContain("raise_errors");
		expect(jsOnly).not.toContain("@tool");
		expect(jsOnly).not.toContain("JS:");

		expect(both).toContain("```python");
		expect(both).toContain("```js");
		expect(both).toContain("JS: `await workpool(");
		expect(both).toContain("raise_errors");
		expect(both).toContain("raiseErrors");
	});

	it("lists the per-call model option only when task.perCallModel admits it for eval", () => {
		const off = renderWorkflowNotice(base);
		const on = renderWorkflowNotice({ ...base, perCallModel: true });

		// agent() and workpool(), in both the Python and JS spellings.
		for (const [text, count] of [
			[off, 0],
			[on, 2],
		] as const) {
			expect(text.match(/model=None\)/g) ?? []).toHaveLength(count);
			expect(text.match(/, model \}\)/g) ?? []).toHaveLength(count);
		}
	});
});
