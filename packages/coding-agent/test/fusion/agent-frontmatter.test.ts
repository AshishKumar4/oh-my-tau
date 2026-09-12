import { describe, expect, it } from "bun:test";
import { getSidekickAgent, parseAgent, renderAgentMarkdown } from "@oh-my-pi/pi-coding-agent/task/agents";

describe("fusion agent frontmatter", () => {
	it("round-trips sidekick: true through the bundled frontmatter template, defaulting off", () => {
		const lead = parseAgent(
			"expert.md",
			renderAgentMarkdown({ name: "expert", description: "Expert lane", sidekick: true }, "Lead your lane."),
			"project",
		);
		expect(lead.sidekick).toBe(true);
		expect(lead.systemPrompt.trim()).toBe("Lead your lane.");

		const plain = parseAgent(
			"worker.md",
			renderAgentMarkdown({ name: "worker", description: "Worker" }, "Work."),
			"project",
		);
		expect(plain.sidekick).toBeUndefined();
		// A sidekick never leads a sidekick of its own.
		expect(getSidekickAgent().sidekick).toBeUndefined();
	});

	it("round-trips pinModel: true, and the bundled sidekick pins its pairing", () => {
		const pinned = parseAgent(
			"pinned.md",
			renderAgentMarkdown({ name: "pinned", description: "Pinned", pinModel: true }, "Stay put."),
			"project",
		);
		expect(pinned.pinModel).toBe(true);
		expect(
			parseAgent("worker.md", renderAgentMarkdown({ name: "worker", description: "Worker" }, "Work."), "project")
				.pinModel,
		).toBeUndefined();
		expect(getSidekickAgent().pinModel).toBe(true);
	});
});
