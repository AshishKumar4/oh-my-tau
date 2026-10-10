import { expect, spyOn, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import * as catalog from "@oh-my-pi/pi-catalog/models";
import { mergeDiscoveredModel } from "@oh-my-pi/pi-coding-agent/config/model-patch";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function fixture(id: string) {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

test("cached catalog reuse preserves explicit limits and refreshed model generations", async () => {
	using directory = TempDir.createSync("@model-merge-reuse-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("openai", "fixture-key");
	const existing = ["fallback", "explicit"].map(id => ({
		...fixture(id),
		omitMaxOutputTokens: true,
		supportsTools: true,
	}));
	const bundled = spyOn(catalog, "getBundledModels").mockImplementation(provider =>
		provider === "openai" ? existing : [],
	);
	try {
		writeModelCache(
			"openai",
			Date.now(),
			[
				{ ...fixture("fallback"), contextWindow: null, maxTokens: null },
				{
					...fixture("explicit"),
					contextWindow: 4096,
					maxTokens: 512,
					omitMaxOutputTokens: false,
					supportsTools: false,
				},
			],
			false,
			fingerprintStaticModels(existing, false),
			directory.join("models.db"),
		);
		const cached = readModelCache("openai", 60_000, Date.now, directory.join("models.db"));
		const explicit = cached?.models.find(model => model.id === "explicit");
		if (!explicit) throw new Error("Expected the cached explicit model");
		expect(mergeDiscoveredModel(explicit, fixture("explicit"))).toBe(explicit);
		const registry = new ModelRegistry(auth, directory.join("models.yml"), { settings: Settings.isolated({}) });
		const before = registry.getAll().filter(model => model.provider === "openai");
		expect(registry.getAvailableForProviders(new Set(["openai"]))).toEqual(before);
		expect(registry.find("openai", "fallback")).toMatchObject({
			contextWindow: 8192,
			maxTokens: 1024,
			omitMaxOutputTokens: true,
			supportsTools: true,
		});
		expect(registry.find("openai", "explicit")).toMatchObject({
			contextWindow: 4096,
			maxTokens: 512,
			omitMaxOutputTokens: false,
			supportsTools: false,
		});
		expect(cached?.models[0]?.contextWindow).toBeNull();
		await Bun.write(
			directory.join("models.yml"),
			"providers:\n  openai:\n    modelOverrides:\n      explicit:\n        contextWindow: 2048\n",
		);
		await registry.refresh("offline");
		expect(registry.find("openai", "explicit")?.contextWindow).toBe(2048);
		expect(before.find(model => model.id === "explicit")?.contextWindow).toBe(4096);
		expect(
			registry.getAll().find(model => model.provider === "openai" && model.id === "explicit")?.contextWindow,
		).toBe(2048);
	} finally {
		bundled.mockRestore();
		auth.close();
	}
});
