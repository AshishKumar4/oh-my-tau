import { describe, expect, it } from "bun:test";
import { harnessToolBinding, harnessWireRenames } from "../src/harness/manifest";

describe("harness manifests", () => {
	it("pins the codex table: two renames, natives untouched and unnamespaced", () => {
		expect(harnessWireRenames("codex")).toEqual({ ask: "request_user_input", eval: "exec" });
		// `collaboration` is reserved server-side for Codex's own multi-agent
		// functions, which the facades provide; a native name there is rejected.
		expect(harnessToolBinding("codex", "task")).toBeUndefined();
		expect(harnessToolBinding("codex", "hub")).toBeUndefined();
	});

	it("pins the claude-code table: seven renames", () => {
		expect(harnessWireRenames("claude-code")).toEqual({
			ask: "AskUserQuestion",
			bash: "Bash",
			edit: "Edit",
			read: "Read",
			task: "Agent",
			web_search: "WebSearch",
			write: "Write",
		});
	});
});
