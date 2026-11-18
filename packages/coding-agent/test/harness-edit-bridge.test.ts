import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Model, toolWireSchema } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";

const CLAUDE_CODE = getBundledModel("anthropic", "claude-opus-5");
const NATIVE = getBundledModel("anthropic", "claude-sonnet-4-5");

const originalEditVariant = Bun.env.PI_EDIT_VARIANT;
const originalStrictEditMode = Bun.env.PI_STRICT_EDIT_MODE;

function toolSession(cwd: string, model: Model): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated(),
		getActiveModel: () => model,
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function wireKeys(tool: EditTool): string[] {
	const schema = toolWireSchema({ name: "edit", description: "", parameters: tool.parameters }) as {
		properties?: Record<string, unknown>;
	};
	return Object.keys(schema.properties ?? {});
}

describe("Edit under the claude-code harness", () => {
	let cwd: string;
	beforeEach(async () => {
		delete Bun.env.PI_EDIT_VARIANT;
		delete Bun.env.PI_STRICT_EDIT_MODE;
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-edit-"));
	});
	afterEach(async () => {
		if (originalEditVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
		else Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		if (originalStrictEditMode === undefined) delete Bun.env.PI_STRICT_EDIT_MODE;
		else Bun.env.PI_STRICT_EDIT_MODE = originalStrictEditMode;
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("selects replace mode and declares Claude Code's Edit fields; off-profile stays hashline", () => {
		expect(resolveEditMode(toolSession(cwd, CLAUDE_CODE))).toBe("replace");
		expect(wireKeys(new EditTool(toolSession(cwd, CLAUDE_CODE)))).toEqual([
			"file_path",
			"old_string",
			"new_string",
			"replace_all",
		]);
		const native = new EditTool(toolSession(cwd, NATIVE));
		expect(native.mode).toBe("hashline");
		expect(wireKeys(native)).toEqual(["input"]);
		expect(wireKeys(new EditTool(toolSession(cwd, CLAUDE_CODE), "hashline"))).toEqual(["input"]);
	});

	it("applies a vendor-shaped replace, honouring replace_all", async () => {
		const file = path.join(cwd, "sample.txt");
		await Bun.write(file, "alpha beta alpha\n");
		const tool = new EditTool(toolSession(cwd, CLAUDE_CODE));
		const ambiguous = await tool.execute("call-1", { file_path: file, old_string: "alpha", new_string: "gamma" });
		expect(ambiguous.isError).toBe(true);
		expect(await Bun.file(file).text()).toBe("alpha beta alpha\n");
		const all = await tool.execute("call-2", {
			file_path: file,
			old_string: "alpha",
			new_string: "gamma",
			replace_all: true,
		});
		expect(all.isError).toBeUndefined();
		expect(await Bun.file(file).text()).toBe("gamma beta gamma\n");
	});

	it("renames only the streamed file_path key, never the same spelling inside a value", async () => {
		const file = path.join(cwd, "config.ts");
		await Bun.write(file, 'const key = "file_path";\n');
		const tool = new EditTool(toolSession(cwd, CLAUDE_CODE));
		const args = {
			file_path: file,
			old_string: 'const key = "file_path";',
			new_string: 'const key = "path"; // was "file_path"',
		};
		const json = JSON.stringify(args);
		const stream = tool.openArgStream({ toolCallId: "call-stream", toolName: "edit", emit: () => {} });
		if (!stream) throw new Error("edit did not open an argument stream");
		const cuts = [0, 4, 9, json.indexOf("old_string") + 20, json.length];
		for (let index = 1; index < cuts.length; index++) stream.push(json.slice(cuts[index - 1], cuts[index]));
		stream.end(args);
		const result = await tool.execute("call-stream", args);
		expect(result.isError).toBeUndefined();
		expect(await Bun.file(file).text()).toBe('const key = "path"; // was "file_path"\n');
	});
});
