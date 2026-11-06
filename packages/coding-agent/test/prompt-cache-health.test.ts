import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	formatPromptCacheHealth,
	PROMPT_CACHE_HEALTH_MIN_SAMPLES,
	promptCacheEma,
	promptCacheHealth,
	promptCacheHitRatio,
	promptCacheP95,
	promptCacheSamplesFromMessages,
	type PromptCacheSample,
} from "@oh-my-pi/pi-coding-agent/session/prompt-cache-stats";

const REQ1: PromptCacheSample = { input: 4, cacheRead: 17124, cacheWrite: 10431 };
const REQ2: PromptCacheSample = { input: 2, cacheRead: 27555, cacheWrite: 95 };
const REQ3: PromptCacheSample = { input: 2, cacheRead: 27650, cacheWrite: 170 };
const REQ5: PromptCacheSample = { input: 2, cacheRead: 27900, cacheWrite: 156 };
const REQ8: PromptCacheSample = { input: 2, cacheRead: 28292, cacheWrite: 140 };
const SESSION = [REQ1, REQ2, REQ3, REQ5, REQ8];

function ratiosOf(samples: PromptCacheSample[]): number[] {
	const ratios: number[] = [];
	for (const sample of samples) {
		const ratio = promptCacheHitRatio(sample);
		if (ratio !== undefined) ratios.push(ratio);
	}
	return ratios;
}

describe("promptCacheHitRatio", () => {
	it("divides cacheRead by the full prompt including cacheWrite", () => {
		expect(promptCacheHitRatio(REQ1)).toBeCloseTo(0.6214, 3);
		expect(promptCacheHitRatio(REQ2)).toBeCloseTo(0.9965, 3);
		expect(promptCacheHitRatio(REQ8)).toBeCloseTo(0.995, 3);
	});

	it("skips requests with no prompt tokens", () => {
		expect(promptCacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
	});
});

describe("promptCacheEma", () => {
	it("seeds with the first ratio and tracks a cold-start recovery within a handful of turns", () => {
		const ratios = ratiosOf(SESSION);
		expect(ratios).toHaveLength(5);
		expect(promptCacheEma([ratios[0]])).toBeCloseTo(0.6214, 3);
		expect(promptCacheEma(ratios)).toBeCloseTo(0.9051, 3);
	});

	it("weights recent requests more than older ones", () => {
		const ratios = ratiosOf(SESSION);
		const forward = promptCacheEma(ratios) ?? 0;
		const reversed = promptCacheEma([...ratios].reverse()) ?? 0;
		expect(reversed).toBeLessThan(forward);
	});

	it("is undefined without ratios", () => {
		expect(promptCacheEma([])).toBeUndefined();
	});
});

describe("promptCacheP95", () => {
	it("returns the nearest-rank P95 of a known sample set", () => {
		expect(promptCacheP95(ratiosOf(SESSION))).toBeCloseTo(0.9965, 3);
		expect(promptCacheP95([0.5, 0.9, 0.7])).toBe(0.9);
	});

	it("is undefined without ratios", () => {
		expect(promptCacheP95([])).toBeUndefined();
	});
});

describe("promptCacheHealth", () => {
	it("pairs EMA with P95 once the sample floor is met", () => {
		const health = promptCacheHealth(SESSION);
		expect(health?.samples).toBe(5);
		expect(health?.ema).toBeCloseTo(0.9051, 3);
		expect(health?.p95).toBeCloseTo(0.9965, 3);
	});

	it("holds P95 back as a placeholder below the sample floor", () => {
		expect(PROMPT_CACHE_HEALTH_MIN_SAMPLES).toBe(5);
		const health = promptCacheHealth([REQ2, REQ3]);
		if (!health) throw new Error("Expected health for two warm requests");
		expect(health.samples).toBe(2);
		expect(health.p95).toBeUndefined();
		expect(formatPromptCacheHealth(health)).toEqual({ kind: "warming", body: "cache …" });
	});

	it("renders full and compact bodies once ready", () => {
		const health = promptCacheHealth(SESSION);
		if (!health) throw new Error("Expected health for the five-request session");
		expect(formatPromptCacheHealth(health)).toEqual({
			kind: "ready",
			full: "cache 91% ema / 100% p95",
			compact: "cache 91/100",
		});
	});

	it("skips zero-denominator requests instead of dragging the average", () => {
		const health = promptCacheHealth([{ input: 0, cacheRead: 0, cacheWrite: 0 }, REQ2]);
		expect(health?.samples).toBe(1);
		expect(health?.ema).toBeCloseTo(0.9965, 3);
	});

	it("is undefined when no request carried prompt tokens", () => {
		expect(promptCacheHealth([{ input: 0, cacheRead: 0, cacheWrite: 0 }])).toBeUndefined();
		expect(promptCacheHealth([])).toBeUndefined();
	});
});

describe("promptCacheSamplesFromMessages", () => {
	it("samples assistant usage in arrival order and ignores the rest", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude-opus-5",
				usage: {
					input: REQ1.input,
					output: 10,
					cacheRead: REQ1.cacheRead,
					cacheWrite: REQ1.cacheWrite,
					totalTokens: REQ1.input + REQ1.cacheRead + REQ1.cacheWrite + 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "second" }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude-opus-5",
				usage: {
					input: REQ2.input,
					output: 10,
					cacheRead: REQ2.cacheRead,
					cacheWrite: REQ2.cacheWrite,
					totalTokens: REQ2.input + REQ2.cacheRead + REQ2.cacheWrite + 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 3,
			},
		];
		const samples = promptCacheSamplesFromMessages(messages);
		expect(samples.map(sample => sample.cacheWrite)).toEqual([REQ1.cacheWrite, REQ2.cacheWrite]);
	});
});
