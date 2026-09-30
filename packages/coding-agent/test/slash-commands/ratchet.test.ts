import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { harnessSurface } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { renderRatchetDocumentation } from "@oh-my-pi/pi-coding-agent/ratchet/prelude";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { cfgRatchetEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function acpRuntime(options: { tools?: string[]; available?: boolean; profile?: "claude-code" } = {}) {
	const settings = Settings.isolated({ "ratchet.enabled": false });
	const tools = options.tools ?? ["read", "eval", "task", "ask"];
	// The session's presented surface, as AgentSession derives it for prompt gates and `toolRefs`.
	const surface = harnessSurface(options.profile, tools, { settings });
	const output = vi.fn();
	const runtime = {
		session: {
			settings,
			getEnabledToolNames: () => tools,
			getPromptToolNames: () => tools.filter(name => !surface.unavailable.has(name)),
			getToolRefs: () => surface.toolRefs,
			getEvalPreludes: () =>
				cfgRatchetEnabled.get(settings) && options.available !== false ? [{ name: "ratchet" }] : [],
		},
		output,
	};
	return { output, runtime, settings, surface };
}

describe("/ratchet slash command", () => {
	it("enables the prelude for the session only and submits the request as data inside the kickoff", async () => {
		const h = acpRuntime();
		const result = await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, [
			"/ratchet the inbox router in src/router, lower cost",
			h.runtime,
		]);
		expect(cfgRatchetEnabled.get(h.settings)).toBe(true);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(result).toHaveProperty("prompt");
		const { prompt } = result as { prompt: string };
		expect(prompt).toContain("<ratchet-request>\nthe inbox router in src/router, lower cost\n</ratchet-request>");
		expect(prompt).toContain("ONE batched `ask`");
	});

	it("tells a session without ask to only continue fully approved flows", async () => {
		const h = acpRuntime({ tools: ["eval", "task"] });
		const { prompt } = (await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/ratchet", h.runtime])) as {
			prompt: string;
		};
		expect(prompt).toContain("No `ask` in this session: NEVER build or approve.");
		expect(prompt).toContain("No flow named");
	});

	it("refuses without the task tool and leaves the prelude off", async () => {
		const h = acpRuntime({ tools: ["eval", "ask"] });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/ratchet router", h.runtime])).toEqual({
			consumed: true,
		});
		expect(cfgRatchetEnabled.get(h.settings)).toBe(false);
		expect(h.output).toHaveBeenCalledWith("/ratchet needs the task tool active.");
	});

	it("names the question tool as a Claude Code session presents it", async () => {
		const h = acpRuntime({ profile: "claude-code" });
		expect(h.surface.toolRefs.ask).toBe("AskUserQuestion");
		const result: unknown = await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/ratchet", h.runtime]);
		if (typeof result !== "object" || result === null || !("prompt" in result) || typeof result.prompt !== "string") {
			throw new Error("/ratchet submitted no kickoff prompt");
		}
		expect(result.prompt).toContain(
			"No flow named — the batched `AskUserQuestion` MUST establish which flow to climb.",
		);
		// The guard sees the tool: the interactive branch, not the headless one.
		expect(result.prompt).toContain("Grill first: read the code, then ONE batched `AskUserQuestion` covering");
		expect(result.prompt).not.toContain("in this session: NEVER build or approve.");
		expect(result.prompt).not.toContain("`ask`");
	});

	it("renders the eval doc with the session's question tool", () => {
		const native = renderRatchetDocumentation(acpRuntime().surface.toolRefs);
		expect(native).toContain("# Phase 1 — Grill (one batched `ask`)");
		expect(native).toContain("then ask everything in one `ask` call");
		expect(native).toContain("Without `ask`, never build or approve.");
		const claudeCode = renderRatchetDocumentation(acpRuntime({ profile: "claude-code" }).surface.toolRefs);
		expect(claudeCode).toContain("# Phase 1 — Grill (one batched `AskUserQuestion`)");
		expect(claudeCode).toContain("then ask everything in one `AskUserQuestion` call");
		expect(claudeCode).toContain("Without `AskUserQuestion`, never build or approve.");
		expect(claudeCode).not.toContain("`ask`");
	});

	it("rolls back when the session cannot host the prelude", async () => {
		const h = acpRuntime({ available: false });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/ratchet router", h.runtime])).toEqual({
			consumed: true,
		});
		expect(cfgRatchetEnabled.get(h.settings)).toBe(false);
		expect(h.output).toHaveBeenCalledWith("The ratchet eval prelude is unavailable in this session.");
	});
});
