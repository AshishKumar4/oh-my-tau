import { describe, expect, it } from "bun:test";
import {
	codeModeIdentifier,
	normalizeCodeModeIdentifier,
} from "@oh-my-pi/pi-coding-agent/harness/code-mode-identifier";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { generateCodeModeDeclarations } from "@oh-my-pi/pi-coding-agent/tools/eval-format/code-mode-declarations";

function vendorNormalizeIdentifier(toolKey: string): string {
	let identifier = "";
	for (const [index, character] of [...toolKey].entries()) {
		const valid =
			index === 0
				? character === "_" || character === "$" || /^[A-Za-z]$/.test(character)
				: character === "_" || character === "$" || /^[A-Za-z0-9]$/.test(character);
		identifier += valid ? character : "_";
	}
	return identifier.length === 0 ? "_" : identifier;
}

const OMP_TOOL_NAMES: readonly string[] = [...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES];

describe("codex code-mode identifier normalization", () => {
	it("reproduces the vendor's vectors", () => {
		const vectors: ReadonlyArray<readonly [string, string]> = [
			["mcp__ologs__get_profile", "mcp__ologs__get_profile"],
			["hidden-dynamic-tool", "hidden_dynamic_tool"],
			["7zip", "_zip"],
			["z7ip", "z7ip"],
			["$sudo", "$sudo"],
			["_leading", "_leading"],
			["", "_"],
			["café", "caf_"],
			["web.search", "web_search"],
		];
		for (const [input, expected] of vectors) {
			expect(normalizeCodeModeIdentifier(input)).toBe(expected);
			expect(vendorNormalizeIdentifier(input)).toBe(expected);
		}
	});

	it("leaves every omp tool name untouched", () => {
		const rewritten = OMP_TOOL_NAMES.filter(name => vendorNormalizeIdentifier(name) !== name);
		expect(rewritten).toEqual([]);
		const diverged = OMP_TOOL_NAMES.filter(
			name => normalizeCodeModeIdentifier(name) !== vendorNormalizeIdentifier(name),
		);
		expect(diverged).toEqual([]);
		expect(OMP_TOOL_NAMES).toContain("web_search");
		expect(OMP_TOOL_NAMES).toContain("new_context");
	});

	it("keeps native tool names as their exec identifiers; the collaboration namespace is the facades' alone", () => {
		expect(codeModeIdentifier("task")).toBe("task");
		expect(codeModeIdentifier("hub")).toBe("hub");
		expect(codeModeIdentifier("read")).toBe("read");
		expect(vendorNormalizeIdentifier("hub")).toBe("hub");
	});

	it("mints MCP tool names that survive normalization, however hostile the server name", () => {
		const minted = [
			createMCPToolName("gh-api", "list PRs!"),
			createMCPToolName("Ol@gs", "get.profile"),
			createMCPToolName("7zip", "extract"),
			createMCPToolName("çafé", "münchen"),
			createMCPToolName("", ""),
		];
		expect(minted.filter(name => normalizeCodeModeIdentifier(name) !== name)).toEqual([]);
		expect(minted[0]).toBe("mcp__gh_api_list_prs");
		expect(minted[4]).toBe("mcp__server_tool");
	});

	it("declares fixed-point names bare and quotes the rest", () => {
		const declarations = generateCodeModeDeclarations([
			{ name: "web_search", parameters: { type: "object", properties: { query: { type: "string" } } } },
			{ name: "hidden-dynamic-tool", parameters: { type: "object", properties: {} } },
		]).split("\n");
		expect(declarations[0]).toStartWith("  web_search(args: {");
		expect(declarations[1]).toStartWith('  "hidden-dynamic-tool"(args:');
		expect(normalizeCodeModeIdentifier("hidden-dynamic-tool")).not.toBe("hidden-dynamic-tool");
	});
});
