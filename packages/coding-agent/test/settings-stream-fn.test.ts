/**
 * Contract: `createSettingsAwareStreamFn` layers session provider settings
 * (`providers.openrouterVariant`, `providers.antigravityEndpoint`,
 * `providers.stream*TimeoutSeconds`, `providers.maxInFlightRequests`,
 * `model.loopGuard.*`, `textVerbosity` for Responses-family requests,
 * `harness.mode` as the `harnessProfile` wire override, the served harness
 * capture's `clientVersion` as `harnessClientVersion`)
 * options win — the same wiring the main agent and the advisor agent share so
 * OpenRouter sticky-routing / response caching behaves the same on advisor turns
 * (can1357/oh-my-pi#3639).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { claudeCodeSystemInstruction } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HARNESS_CAPTURE_SCHEMA, loadHarnessPrompt } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { withHarnessCacheDir } from "./helpers/harness";

function captureBase(): { fn: StreamFn; calls: Array<{ options?: SimpleStreamOptions }> } {
	const calls: Array<{ options?: SimpleStreamOptions }> = [];
	const fn: StreamFn = (_model, _context, options) => {
		calls.push({ options });
		return new AssistantMessageEventStream();
	};
	return { fn, calls };
}

const stubModel = {} as unknown as Model;
const stubCodexModel = { api: "openai-codex-responses" } as unknown as Model;
const stubResponsesModel = { api: "openai-responses" } as unknown as Model;
const stubContext = { messages: [], tools: [], systemPrompt: [] } as unknown as Context;

/** Base64 PNG whose IHDR declares `width`x`height`; the pixel data is irrelevant to sizing. */
function pngWithSize(width: number, height: number): string {
	const bytes = Buffer.alloc(64);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return bytes.toString("base64");
}

describe("createSettingsAwareStreamFn", () => {
	it("applies provider settings to the forwarded options when caller omits them", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
			"model.loopGuard.checkAssistantContent": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, { apiKey: "k" });

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("floor");
		expect(options?.antigravityEndpointMode).toBe("sandbox");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 4 });
		expect(options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
		// caller's own option is preserved
		expect(options?.apiKey).toBe("k");
	});

	it("threads native as null and forced profiles through, preserving caller pins", () => {
		const profiled = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "x",
			identity: { class: "anthropic" },
		} as unknown as Model;
		for (const [mode, expected] of [
			["native", null],
			["claude-code", "claude-code"],
			["codex", "codex"],
		] as const) {
			const settings = Settings.isolated({ "harness.mode": mode });
			const { fn: base, calls } = captureBase();
			createSettingsAwareStreamFn(settings, base)(profiled, stubContext, { apiKey: "k" });
			expect(calls[0]?.options?.harnessProfile).toBe(expected);
		}
		// auto on an identity-less stub resolves no profile -> null (native wire).
		const autoSettings = Settings.isolated({});
		const { fn: base, calls } = captureBase();
		createSettingsAwareStreamFn(autoSettings, base)(stubModel, stubContext, { apiKey: "k" });
		expect(calls[0]?.options?.harnessProfile).toBeNull();
		// Caller-supplied overrides win over the session mode.
		const nativeSettings = Settings.isolated({ "harness.mode": "native" });
		const { fn: base2, calls: calls2 } = captureBase();
		createSettingsAwareStreamFn(nativeSettings, base2)(profiled, stubContext, {
			apiKey: "k",
			harnessProfile: "codex",
		});
		expect(calls2[0]?.options?.harnessProfile).toBe("codex");
	});

	it("forwards configured hidden thinking summaries", () => {
		const settings = Settings.isolated({ omitThinking: true });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(true);
	});

	it("applies Codex text verbosity only when settings or caller options configure it", () => {
		const unconfiguredSettings = Settings.isolated({});
		const { fn: unconfiguredBase, calls: unconfiguredCalls } = captureBase();
		const unconfiguredWrapped = createSettingsAwareStreamFn(unconfiguredSettings, unconfiguredBase);

		unconfiguredWrapped(stubCodexModel, stubContext, undefined);
		unconfiguredWrapped(stubCodexModel, stubContext, { textVerbosity: "medium" });

		expect(unconfiguredCalls[0]?.options?.textVerbosity).toBeUndefined();
		expect(unconfiguredCalls[1]?.options?.textVerbosity).toBe("medium");

		const settings = Settings.isolated({ textVerbosity: "low" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubCodexModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, { textVerbosity: "medium" });

		expect(calls[0]?.options?.textVerbosity).toBe("low");
		expect(calls[1]?.options?.textVerbosity).toBe("low");
		expect(calls[2]?.options?.textVerbosity).toBe("medium");
	});

	it("forwards configured stream watchdog budgets while preserving caller overrides", () => {
		const settings = Settings.isolated({
			"providers.streamFirstEventTimeoutSeconds": 600,
			"providers.streamIdleTimeoutSeconds": 300,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, {
			streamFirstEventTimeoutMs: 15_000,
			streamIdleTimeoutMs: 10_000,
		});

		expect(calls[0]?.options?.streamFirstEventTimeoutMs).toBe(600_000);
		expect(calls[0]?.options?.streamIdleTimeoutMs).toBe(300_000);
		expect(calls[1]?.options?.streamFirstEventTimeoutMs).toBe(15_000);
		expect(calls[1]?.options?.streamIdleTimeoutMs).toBe(10_000);
	});

	it("forwards retry.maxDelayMs while preserving caller overrides", () => {
		const settings = Settings.isolated({ "retry.maxDelayMs": 300_000 });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, { maxRetryDelayMs: 5_000 });

		expect(calls[0]?.options?.maxRetryDelayMs).toBe(300_000);
		expect(calls[1]?.options?.maxRetryDelayMs).toBe(5_000);
	});

	it("treats the default openrouterVariant as absent so the base call carries no variant", () => {
		const settings = Settings.isolated({ "providers.openrouterVariant": "default" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.openrouterVariant).toBeUndefined();
	});

	it("forwards configured cache retention, leaves auto unset, and lets callers override", () => {
		const auto = captureBase();
		createSettingsAwareStreamFn(Settings.isolated({}), auto.fn)(stubModel, stubContext, undefined);
		// auto must stay unset so provider defaults and PI_CACHE_RETENTION apply
		expect(auto.calls[0]?.options?.cacheRetention).toBeUndefined();

		const long = captureBase();
		const settings = Settings.isolated({ "providers.cacheRetention": "long" });
		const wrapped = createSettingsAwareStreamFn(settings, long.fn);
		wrapped(stubModel, stubContext, undefined);
		expect(long.calls[0]?.options?.cacheRetention).toBe("long");

		wrapped(stubModel, stubContext, { cacheRetention: "none" });
		expect(long.calls[1]?.options?.cacheRetention).toBe("none");
	});

	it("lets caller-supplied options override the session settings", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, {
			openrouterVariant: "nitro",
			antigravityEndpointMode: "production",
			maxInFlightRequests: { openrouter: 1 },
			loopGuard: { enabled: false },
			hideThinkingSummary: false,
		});

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("nitro");
		expect(options?.antigravityEndpointMode).toBe("production");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 1 });
		// Loop guard merges per-field: caller wins on `enabled`, settings fill
		// the rest (the inline closure the main agent used has the same shape).
		expect(options?.loopGuard?.enabled).toBe(false);
		expect(options?.loopGuard?.checkAssistantContent).toBe(true);
		expect(options?.hideThinkingSummary).toBe(false);
	});

	it("lowers the output cap so prompt plus output fits the model's context window", () => {
		// The reported DeepSeek /btw 400: a 666k-token prompt plus the model's
		// 384k default output cap exceeded the window. Test-env counts are bytes/4.
		const deepseek: Model = {
			...getBundledModel("deepseek", "deepseek-v4-pro"),
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		};
		const promptTokens = 666_387;
		const context = {
			messages: [{ role: "user", content: "x".repeat(promptTokens * 4), timestamp: 0 }],
		} as unknown as Context;
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

		wrapped(deepseek, context, { apiKey: "k" });
		wrapped(deepseek, stubContext, { apiKey: "k" });

		const fitted = calls[0]?.options?.maxTokens;
		expect(fitted).toBeGreaterThan(0);
		expect(promptTokens + (fitted ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1_000_000);
		// A prompt that leaves room keeps the transport's own default.
		expect(calls[1]?.options?.maxTokens).toBeUndefined();
	});

	it("refits after a same-id model replacement changes how its history is counted", () => {
		// A models.yml override or registry refresh can swap the Model behind one
		// provider, api and id. Bound to its conversation prefix, it bills another
		// Claude model's signed reasoning from its deployment at the turn's output.
		const vertex = getBundledModel<"anthropic-messages">("google-vertex", "claude-opus-5@default");
		if (!vertex.thinking) throw new Error("Expected Claude Opus 5 on Vertex to think");
		const sized = { ...vertex, contextWindow: 10_000, maxTokens: 8_000 };
		const bound: Model = { ...sized, thinking: { ...vertex.thinking, prefixBinding: true } };
		const unbound: Model = { ...sized, thinking: { ...vertex.thinking, prefixBinding: false } };
		const context: Context = {
			messages: [
				// A rewrite marker newer than the turn makes its usage stale, so it is counted locally.
				{ role: "user", content: "summary", historyRewriteAt: 10, timestamp: 10 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Plan.", thinkingSignature: "s".repeat(400) },
						{ type: "text", text: "Done." },
					],
					api: vertex.api,
					provider: vertex.provider,
					model: "claude-opus-4-7@default",
					usage: {
						input: 100,
						output: 6_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 6_100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		};
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

		wrapped(bound, context, { apiKey: "k" });
		wrapped(unbound, context, { apiKey: "k" });

		// The bound model's prompt carries the 6,000 reasoning tokens, so its cap is fitted.
		expect(calls[0]?.options?.maxTokens).toBeLessThan(8_000);
		// The replacement drops that reasoning: its prompt is a few tokens.
		expect(calls[1]?.options?.maxTokens).toBeUndefined();
	});

	it("fits the output cap at the called model's prices, not an earlier model's", () => {
		// Gemini bills any image a flat 1,120 tokens; GPT-6.1 bills this one 4,763.
		const gemini = getBundledModel("google", "gemini-3-pro-preview");
		const codex: Model = { ...getBundledModel("openai-codex", "gpt-6.1-sol"), contextWindow: 10_000 };
		const image: ImageContent = {
			type: "image",
			data: pngWithSize(2000, 2000),
			mimeType: "image/png",
			detail: "original",
		};
		const context: Context = { messages: [{ role: "user", content: [image], timestamp: 0 }] };
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);
		const fresh = captureBase();

		wrapped(gemini, stubContext, { maxTokens: 8_000 });
		wrapped(codex, context, { maxTokens: 8_000 });
		createSettingsAwareStreamFn(Settings.isolated({}), fresh.fn)(codex, context, { maxTokens: 8_000 });

		const fitted = calls[1]?.options?.maxTokens ?? Number.POSITIVE_INFINITY;
		expect(fitted).toBe(fresh.calls[0]?.options?.maxTokens ?? Number.NaN);
		expect(4_763 + fitted).toBeLessThanOrEqual(10_000);
	});

	describe("providers.anthropic.serverSideFallback (opt-in)", () => {
		const stubFableModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-fable-5",
		} as unknown as Model;
		const stubOpusModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4-8",
		} as unknown as Model;
		const stubFable51Model = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-fable-5-1",
		} as unknown as Model;
		const stubMythosModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-mythos-5-1",
		} as unknown as Model;
		const stubBedrockFableModel = {
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			id: "anthropic.claude-fable-5-1",
		} as unknown as Model;

		it("stays off by default: no fallbacks injected on any model", () => {
			const settings = Settings.isolated({});
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		// Targets must be in the model's `allowed_fallback_models`; Fable 5 / 5.1
		// publish ["claude-opus-4-8", "claude-opus-5"] and reject claude-opus-5-5
		// with a 400 (#13059).
		it.each([
			["Fable 5", stubFableModel],
			["Fable 5.1", stubFable51Model],
			["Mythos 5.1", stubMythosModel],
		])("injects an allowed Opus 5 fallback for %s when the setting is on", (_label, model) => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(model, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-opus-5" }]);
		});

		it("does NOT inject fallbacks for Fable off first-party Anthropic even when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubBedrockFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("does NOT inject fallbacks on non-Fable/Mythos Anthropic models even when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubOpusModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("caller-supplied fallbacks always win over the settings default", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, {
				apiKey: "k",
				fallbacks: [{ model: "claude-sonnet-5" }],
			});

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-sonnet-5" }]);
		});
	});
});

describe("createSettingsAwareStreamFn served harness capture", () => {
	const dirs = withHarnessCacheDir("omp-settings-stream-capture-");

	it("threads the served capture's client version to the provider, and none without one", async () => {
		const model = getBundledModel("anthropic", "claude-opus-5-5");
		const forwardedVersion = (mode: "auto" | "claude-code" | "native", options: SimpleStreamOptions = {}) => {
			const { fn: base, calls } = captureBase();
			createSettingsAwareStreamFn(Settings.isolated({ "harness.mode": mode }), base)(model, stubContext, {
				apiKey: "k",
				...options,
			});
			return calls[0]?.options?.harnessClientVersion;
		};
		// Nothing served yet: the provider keeps the pinned wire version.
		expect(forwardedVersion("claude-code")).toBeUndefined();

		const profileDir = path.join(dirs.cache, "claude-code");
		fs.mkdirSync(profileDir, { recursive: true });
		fs.writeFileSync(
			path.join(profileDir, "2.1.284.b93-cli-claude-opus-5-5.json"),
			JSON.stringify({
				schema: HARNESS_CAPTURE_SCHEMA,
				profile: "claude-code",
				clientVersion: "2.1.284.b93",
				entrypoint: "cli",
				capturedAt: "2026-09-29T17:08:36.689Z",
				model: "claude-opus-5-5",
				instructions: [
					"x-anthropic-billing-header: cc_version=2.1.284.b93; cc_entrypoint=cli;",
					claudeCodeSystemInstruction,
					"You are a coding CLI.",
				],
				tools: ["Bash", "Read"],
			}),
		);
		expect(await loadHarnessPrompt("claude-code", model.id)).not.toBeNull();

		expect(forwardedVersion("claude-code")).toBe("2.1.284.b93");
		expect(forwardedVersion("auto")).toBe("2.1.284.b93");
		// Native mode serves no capture, so its wire keeps the pinned version.
		expect(forwardedVersion("native")).toBeUndefined();
		// A caller-supplied version wins, like every other stream option.
		expect(forwardedVersion("claude-code", { harnessClientVersion: "2.1.290.abc" })).toBe("2.1.290.abc");
	});
});
