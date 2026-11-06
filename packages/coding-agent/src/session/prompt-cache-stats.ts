import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";

export const NATIVE_HARNESS_LABEL = "native";

const HARNESS_LABELS = new Map<string, string>();

export function harnessLabel(provider: string, modelId: string): string {
	const key = `${provider}\u0000${modelId}`;
	let label = HARNESS_LABELS.get(key);
	if (label === undefined) {
		const model = getBundledModel(provider as GeneratedProvider, modelId) as Model | undefined;
		label = (model && resolveHarnessProfile(model)) ?? NATIVE_HARNESS_LABEL;
		HARNESS_LABELS.set(key, label);
	}
	return label;
}

export interface HarnessCacheStats {
	requests: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	// Token-weighted across all requests: cacheRead tokens over total prompt
	// tokens. A different statistic from the per-request EMA/P95 in
	// PromptCacheHealth, where each request counts once regardless of size.
	hitPct: number;
}

export interface PromptCacheSample {
	requests?: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export function promptTokenTotal(sample: PromptCacheSample): number {
	return sample.input + sample.cacheRead + sample.cacheWrite;
}

export class PromptCacheRollup {
	readonly #buckets = new Map<string, PromptCacheSample & { requests: number }>();

	add(label: string, sample: PromptCacheSample): void {
		let bucket = this.#buckets.get(label);
		if (bucket === undefined) {
			bucket = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
			this.#buckets.set(label, bucket);
		}
		bucket.requests += sample.requests ?? 1;
		bucket.input += sample.input;
		bucket.cacheRead += sample.cacheRead;
		bucket.cacheWrite += sample.cacheWrite;
	}

	entries(): [string, HarnessCacheStats][] {
		const rows: [string, HarnessCacheStats][] = [];
		for (const [label, bucket] of this.#buckets) {
			const total = promptTokenTotal(bucket);
			if (total === 0) continue;
			rows.push([label, { ...bucket, hitPct: (bucket.cacheRead / total) * 100 }]);
		}
		rows.sort(
			([aLabel, a], [bLabel, b]) => promptTokenTotal(b) - promptTokenTotal(a) || aLabel.localeCompare(bLabel),
		);
		return rows;
	}

	toRecord(): Record<string, HarnessCacheStats> | undefined {
		const rows = this.entries();
		return rows.length > 0 ? Object.fromEntries(rows) : undefined;
	}
}

// Alpha 0.3 tracks a step change to ~83% within 5 turns while a single cold
// miss moves the readout by less than a third, so the legitimately-low first
// request stops dominating after a handful of turns without hiding re-writes.
export const PROMPT_CACHE_HEALTH_EMA_ALPHA = 0.3;
// Below 5 samples the EMA is still turn-1 dominated and nearest-rank P95 is
// provably the max, so the indicator holds a placeholder instead of a number.
export const PROMPT_CACHE_HEALTH_MIN_SAMPLES = 5;

export function promptCacheHitRatio(sample: PromptCacheSample): number | undefined {
	const total = sample.cacheRead + sample.cacheWrite + sample.input;
	if (!(total > 0)) return undefined;
	return sample.cacheRead / total;
}

export function promptCacheEma(ratios: readonly number[]): number | undefined {
	let ema: number | undefined;
	for (const ratio of ratios) {
		ema =
			ema === undefined ? ratio : PROMPT_CACHE_HEALTH_EMA_ALPHA * ratio + (1 - PROMPT_CACHE_HEALTH_EMA_ALPHA) * ema;
	}
	return ema;
}

export function promptCacheP95(ratios: readonly number[]): number | undefined {
	if (ratios.length === 0) return undefined;
	const sorted = [...ratios].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

export interface PromptCacheHealth {
	// Valid per-request ratios seen, counting every request including ratios that
	// have since aged out of the retained P95 window below.
	samples: number;
	// EMA(0.3) over arrival-order per-request ratios. Each request counts once no
	// matter its size, unlike HarnessCacheStats.hitPct which weights by tokens;
	// the TUI indicator shows this per-request view, not the token-weighted one.
	ema: number;
	// Nearest-rank P95 over the retained window (the last
	// PROMPT_CACHE_HEALTH_RING_SIZE valid requests), not all time. Undefined
	// below the sample floor so the indicator can hold its placeholder.
	p95: number | undefined;
}

export function promptCacheHealth(samples: readonly PromptCacheSample[]): PromptCacheHealth | undefined {
	const ratios: number[] = [];
	for (const sample of samples) {
		const ratio = promptCacheHitRatio(sample);
		if (ratio !== undefined) ratios.push(ratio);
	}
	const ema = promptCacheEma(ratios);
	if (ema === undefined) return undefined;
	return {
		samples: ratios.length,
		ema,
		p95: ratios.length >= PROMPT_CACHE_HEALTH_MIN_SAMPLES ? promptCacheP95(ratios) : undefined,
	};
}

export function promptCacheSamplesFromMessages(messages: readonly AgentMessage[]): PromptCacheSample[] {
	const samples: PromptCacheSample[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage) continue;
		samples.push(usage);
	}
	return samples;
}

export type PromptCacheHealthBody =
	| { kind: "ready"; full: string; compact: string }
	| { kind: "warming"; body: string };

export function formatPromptCacheHealth(health: PromptCacheHealth): PromptCacheHealthBody {
	if (health.p95 === undefined) return { kind: "warming", body: "cache …" };
	const ema = Math.round(health.ema * 100);
	const p95 = Math.round(health.p95 * 100);
	return { kind: "ready", full: `cache ${ema}% ema / ${p95}% p95`, compact: `cache ${ema}/${p95}` };
}

// P95 retains the last 100 valid per-request ratios. Nearest-rank P95 needs at
// least 20 samples to resolve below the max (ceil(0.95N) < N), so 100 ranks a
// full window on its 6th-largest ratio instead of an outlier. 100 doubles bound
// render work to a short constant sort however long the session grows, and the
// EMA has forgotten older requests by then anyway (a sample 20 back weighs
// 0.3*0.7^19, under a tenth of a percent), so the window covers the same
// effective horizon the EMA still responds to.
export const PROMPT_CACHE_HEALTH_RING_SIZE = 100;
