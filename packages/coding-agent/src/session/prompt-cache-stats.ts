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
	// tokens. A different statistic from the status-line gauge's per-request
	// EMA/P95, where each request counts once regardless of size.
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
