import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WebSearchTool, withDomainOperators } from "@oh-my-pi/pi-coding-agent/web/search";
import * as modelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import * as modelRoles from "@oh-my-pi/pi-coding-agent/config/model-roles";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";

const CLAUDE_CODE = getBundledModel("anthropic", "claude-opus-5");
const PROFILED = { getActiveModel: () => CLAUDE_CODE } as unknown as ToolSession;
const NATIVE = {} as ToolSession;

function captureProvider(): { params: SearchParams | undefined } {
	const captured: { params: SearchParams | undefined } = { params: undefined };
	// Upstream moved provider selection onto the model role chain; stub that seam
	// so the tool reaches the fake provider below without a live registry.
	// The pool is built from live settings before the chain resolves, so stub both.
	vi.spyOn(modelRoles, "roleCandidatePool").mockReturnValue([CLAUDE_CODE]);
	vi.spyOn(modelResolver, "resolveRoleChain").mockReturnValue([{ model: CLAUDE_CODE, explicit: false }]);
	vi.spyOn(provider, "getSearchProvider").mockResolvedValue({
		id: "codex",
		label: "codex",
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: async params => {
			captured.params = params;
			return { provider: "codex", sources: [{ title: "r", url: "https://docs.rs/x" }] };
		},
	});
	return captured;
}

function wireKeys(tool: WebSearchTool): string[] {
	const schema = toolWireSchema({ name: "web_search", description: "", parameters: tool.parameters }) as {
		properties: Record<string, unknown>;
	};
	return Object.keys(schema.properties);
}

describe("WebSearch under the claude-code harness", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("declares Claude Code's WebSearch fields under the profile and omp's own otherwise", () => {
		expect(wireKeys(new WebSearchTool(PROFILED))).toEqual(["query", "allowed_domains", "blocked_domains"]);
		expect(wireKeys(new WebSearchTool(NATIVE))).toContain("recency");
		expect(wireKeys(new WebSearchTool(NATIVE))).not.toContain("allowed_domains");
	});

	it("folds allowed and blocked domains into site: operators the query pipeline enforces", async () => {
		const captured = captureProvider();
		await new WebSearchTool(PROFILED).execute("call-1", {
			query: "rust async",
			allowed_domains: ["docs.rs", "rust-lang.org"],
			blocked_domains: ["reddit.com"],
		});
		expect(captured.params?.query).toBe("rust async (site:docs.rs OR site:rust-lang.org) -site:reddit.com");
		expect(captured.params?.parsedQuery?.sites).toEqual(["docs.rs", "rust-lang.org"]);
		expect(captured.params?.parsedQuery?.excludedSites).toEqual(["reddit.com"]);
	});

	it("leaves a filter-free vendor query byte-identical", () => {
		expect(withDomainOperators("rust async")).toBe("rust async");
		expect(withDomainOperators("rust async", ["docs.rs"])).toBe("rust async site:docs.rs");
	});
});
