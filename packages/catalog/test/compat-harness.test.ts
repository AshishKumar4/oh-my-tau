import { afterEach, describe, expect, test, vi } from "bun:test";
import * as cascade from "../src/compat/cascade";
import { resolveHarnessProfile } from "../src/compat/harness";
import { getBundledModel } from "../src/models";
import type { Model } from "../src/types";

describe("resolveHarnessProfile", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("walks the rule cascade once per model object", () => {
		const astra = getBundledModel("openai-codex", "gpt-6-astra");
		const legacy = getBundledModel("openai-codex", "gpt-5.6-luna");
		expect(resolveHarnessProfile(astra)).toBe("codex");
		expect(resolveHarnessProfile(legacy)).toBeUndefined();

		const spy = vi.spyOn(cascade, "resolveCascade");
		expect(resolveHarnessProfile(astra)).toBe("codex");
		expect(resolveHarnessProfile(astra)).toBe("codex");
		expect(resolveHarnessProfile(legacy)).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});

	test("a re-routed clone resolves against its own api, not a shared id", () => {
		const direct = getBundledModel("anthropic", "claude-opus-5");
		expect(resolveHarnessProfile(direct)).toBe("claude-code");

		// The shape `prepareModel` hands the stream: one provider/id pair, rewritten api.
		const rerouted: Model = { ...direct, api: "openai-completions" };

		expect(resolveHarnessProfile(rerouted)).toBeUndefined();
	});
});
