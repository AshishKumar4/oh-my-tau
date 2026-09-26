import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveSidekickModel } from "@oh-my-pi/pi-coding-agent/fusion/config";
import {
	cfgFusionEnabled,
	cfgFusionSidekickModel,
	cfgFusionSidekickThinking,
} from "@oh-my-pi/pi-coding-agent/fusion/settings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

describe("fusion settings", () => {
	it("ships off, on SWE-2 at medium thinking, and reports an unresolvable sidekick model by its selector", () => {
		const settings = Settings.isolated();
		expect(cfgFusionEnabled.get(settings)).toBe(false);
		expect(cfgFusionSidekickModel.get(settings)).toBe("devin/swe-2");
		expect(cfgFusionSidekickThinking.get(settings)).toBe(Effort.Medium);
		const registry = {
			getAll: () => [],
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
		} as unknown as ModelRegistry;
		const resolution = resolveSidekickModel(settings, registry);
		expect(resolution.model).toBeUndefined();
		expect(resolution.pattern).toBe("devin/swe-2");
		expect(resolution.error).toBeDefined();
	});
});
