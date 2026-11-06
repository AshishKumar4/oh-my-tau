import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type HarnessBridges, harnessParameters, harnessParams } from "@oh-my-pi/pi-coding-agent/harness/bridge";

const native = type({ path: "string" });
const vendor = type({ file_path: "string" });
const BRIDGES: HarnessBridges<{ path: string }> = {
	"claude-code": { parameters: vendor, toParams: (args: { file_path: string }) => ({ path: args.file_path }) },
};

// Bridge hosts are tool sessions: the profile follows their `harness.mode` (default auto).
function host(model: Model | undefined, settings = Settings.isolated()) {
	return { getActiveModel: () => model, settings };
}

describe("harness schema bridge", () => {
	it("presents the vendor schema and maps its arguments under the bridged profile", () => {
		const session = host(getBundledModel("anthropic", "claude-opus-5"));
		expect(harnessParameters(session, BRIDGES, native)).toBe(vendor);
		expect(harnessParams(session, BRIDGES, { file_path: "a.ts" })).toEqual({ path: "a.ts" });
	});

	it("keeps omp's own schema and arguments on a profile without a bridge and off-profile", () => {
		for (const session of [
			host(getBundledModel("openai-codex", "gpt-6-astra")),
			host(getBundledModel("anthropic", "claude-sonnet-4-5")),
			host(getBundledModel("anthropic", "claude-opus-5"), Settings.isolated({ "harness.mode": "native" })),
			null,
		]) {
			expect(harnessParameters(session, BRIDGES, native)).toBe(native);
			expect(harnessParams(session, BRIDGES, { path: "a.ts" })).toEqual({ path: "a.ts" });
		}
	});
});
