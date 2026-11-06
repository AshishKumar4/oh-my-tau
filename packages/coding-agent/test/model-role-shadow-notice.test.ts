import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { shadowedModelRoleNotice } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getProjectAgentDir, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("shadowedModelRoleNotice", () => {
	let testDir: string;
	let projectDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `role-shadow-${Snowflake.next()}`);
		projectDir = path.join(testDir, "project");
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	});

	const load = () => Settings.loadIsolated({ cwd: projectDir, agentDir: testDir, inMemory: true });

	it("warns when a project pin keeps overriding a global role assignment", async () => {
		fs.writeFileSync(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			"modelRoles:\n  slow: openai-codex/gpt-6-astra:max\n",
		);
		const settings = await load();

		settings.setModelRole("slow", "anthropic/claude-opus-5-5:high");

		expect(settings.getModelRole("slow")).toBe("openai-codex/gpt-6-astra:max");
		const notice = shadowedModelRoleNotice(settings, "slow", "anthropic/claude-opus-5-5:high", "Slow model");
		expect(notice).toContain("anthropic/claude-opus-5-5:high");
		expect(notice).toContain("this project's settings");
		expect(notice).toContain("openai-codex/gpt-6-astra:max");
		expect(notice).toContain("modelRoleStorage: project");
	});

	it("stays silent when the assigned value is the one that applies", async () => {
		const settings = await load();

		settings.setModelRole("slow", "anthropic/claude-opus-5-5:high");

		expect(shadowedModelRoleNotice(settings, "slow", "anthropic/claude-opus-5-5:high", "Slow model")).toBeUndefined();
	});

	it("stays silent for a project assignment that replaces the project pin", async () => {
		fs.writeFileSync(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			"modelRoles:\n  slow: openai-codex/gpt-6-astra:max\n",
		);
		const settings = await load();

		settings.setProjectModelRole("slow", "anthropic/claude-opus-5-5:high");

		expect(shadowedModelRoleNotice(settings, "slow", "anthropic/claude-opus-5-5:high", "Slow model")).toBeUndefined();
	});
});
