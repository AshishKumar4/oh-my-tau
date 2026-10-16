import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, ModelSpec, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { contextIdentity } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { decorateContextImages } from "@oh-my-pi/pi-coding-agent/blob-broker/context-images";
import {
	capArchiveFrameBytes,
	clampProviderContextImageBytes,
	clampProviderContextImages,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const OPENAI_RESPONSES_MODEL = buildModel({
	id: "gpt-5.2",
	name: "gpt-5.2",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const ANTHROPIC_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-test",
	name: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 4096,
};
const ANTHROPIC_MODEL = buildModel(ANTHROPIC_SPEC);
const ANTHROPIC_PROXY_MODEL = buildModel({ ...ANTHROPIC_SPEC, baseUrl: "https://anthropic-proxy.example.com" });
const CODEX_MODEL = getBundledModel("openai-codex", "gpt-6.1-sol");
const CODEX_PROXY_MODEL = buildModel({
	...toModelSpec(CODEX_MODEL),
	baseUrl: "https://codex-proxy.example/backend-api",
});
const ANTIGRAVITY_CLAUDE_MODEL = getBundledModel("google-antigravity", "claude-sonnet-4-6");
const ANTIGRAVITY_GEMINI_MODEL = getBundledModel("google-antigravity", "gemini-3.7-flash");
const XAI_MODEL = getBundledModel("xai", "grok-4.7");
const XAI_OAUTH_MODEL = getBundledModel("xai-oauth", "grok-4.7");
const CURSOR_CLAUDE_MODEL = getBundledModel("cursor", "claude-opus-5-high");
const CURSOR_GPT_MODEL = getBundledModel("cursor", "gpt-5.5");
const CURSOR_DEFAULT_MODEL = getBundledModel("cursor", "default");
// A base64 character occupies one byte in Anthropic's JSON request body.
const HALF_ANTHROPIC_IMAGE_BUDGET = "A".repeat(12_000_000);

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const context: Context = {
			systemPrompt: ["system"],
			tools: [],
			messages: Array.from({ length: 31 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		const kept = imageData(clamped);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThanOrEqual(10);
		expect(kept).toEqual(imageData(context).slice(-kept.length));
		expect(textData(clamped)).toEqual(Array.from({ length: 31 }, (_, index) => `text-${index}`));
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it("keeps the earlier request byte-identical while a growing conversation adds images past the cap", () => {
		const model = ANTHROPIC_PROXY_MODEL;
		const turn = (index: number): Context["messages"][number] => ({
			role: "user",
			content: [text(`look at screenshot ${index}`), image(`screenshot-${index}`)],
			timestamp: index,
		});
		let previous: Context["messages"] = [];
		let rewrites = 0;
		const added = 120;
		for (let total = 1; total <= 90 + added; total++) {
			const messages = Array.from({ length: total }, (_, index) => turn(index));
			const sent = clampProviderContextImages({ systemPrompt: ["system"], tools: [], messages }, model).messages;
			expect(imageData({ systemPrompt: [], tools: [], messages: sent }).length).toBeLessThanOrEqual(90);
			expect(JSON.stringify(sent.at(-1))).toContain(`screenshot-${total - 1}`);
			if (JSON.stringify(sent.slice(0, previous.length)) !== JSON.stringify(previous)) rewrites++;
			previous = sent;
		}
		// Each rewrite re-sends the whole cached prompt; it may happen once per batch of images, not per image.
		expect(rewrites).toBeLessThanOrEqual(Math.ceil(added / 20));
	});

	it("clamps a tool result's current content after its owner rewrites it in place", () => {
		// Shake replaces a tool result's content array, keeping its images, and marks it pruned.
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-shots",
			toolName: "bash",
			content: [text("CAPTURE-LOG"), ...Array.from({ length: 12 }, (_, index) => image(`shot-${index}`))],
			isError: false,
			timestamp: 1,
		};
		const clamp = () => clampProviderContextImages({ systemPrompt: [], tools: [], messages: [result] }, UMANS_MODEL);
		const first = clamp();
		expect(textData(first)).toEqual(["CAPTURE-LOG"]);

		result.content = [text("[shaken]"), ...result.content.filter(part => part.type === "image")];
		result.prunedAt = 2;
		const second = clamp();

		// The same images drop, and what goes out is what the message holds now.
		expect(imageData(second)).toEqual(imageData(first));
		expect(textData(second)).toEqual(["[shaken]"]);
		expect(second.messages[0]).toMatchObject({ prunedAt: 2 });
	});

	it.each([
		["the official Anthropic API", ANTHROPIC_MODEL, 600],
		["an Anthropic proxy", ANTHROPIC_PROXY_MODEL, 90],
		["the official Codex backend", CODEX_MODEL, 2000],
		["a Codex proxy", CODEX_PROXY_MODEL, 200],
		["Claude on Antigravity", ANTIGRAVITY_CLAUDE_MODEL, 20],
		["Gemini on Antigravity", ANTIGRAVITY_GEMINI_MODEL, 60],
		["xAI", XAI_MODEL, 60],
		["xAI OAuth", XAI_OAUTH_MODEL, 60],
		["Claude on Cursor", CURSOR_CLAUDE_MODEL, 20],
		["GPT on Cursor", CURSOR_GPT_MODEL, 60],
		["Cursor's default route", CURSOR_DEFAULT_MODEL, 20],
	] as const)("keeps the newest images up to the count %s allows", (_label, model, budget) => {
		const imaged = (count: number): Context => ({
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: count }, (_, index) => ({
				role: "user",
				content: [image(`image-${index}`)],
				timestamp: index,
			})),
		});
		const full = imaged(budget);
		expect(clampProviderContextImages(full, model)).toBe(full);

		// One past the budget drops a quarter-budget step of the oldest images.
		const step = Math.max(1, Math.floor(budget / 4));
		const clamped = clampProviderContextImages(imaged(budget + 1), model);

		expect(imageData(clamped)).toEqual(
			Array.from({ length: budget + 1 - step }, (_, index) => `image-${index + step}`),
		);
	});

	it.each([
		// Claude's upstream message limit on Antigravity; Gemini there took 64 MB.
		["Claude on Antigravity", ANTIGRAVITY_CLAUDE_MODEL, 30_000_000],
		["Gemini on Antigravity", ANTIGRAVITY_GEMINI_MODEL, 64_000_000],
		// api.x.ai rejects a body over 50 MiB.
		["xAI", XAI_MODEL, 52_428_800],
		["xAI OAuth", XAI_OAUTH_MODEL, 52_428_800],
		// Cursor took a 64 MB body for both upstreams.
		["Claude on Cursor", CURSOR_CLAUDE_MODEL, 64_000_000],
		["GPT on Cursor", CURSOR_GPT_MODEL, 64_000_000],
	] as const)(
		"keeps %s under its measured body limit at omp's 500 KiB image resize target",
		(_label, model, bodyLimit) => {
			// No byte budget applies on these hosts, so the count alone bounds the
			// inline bytes of resized screenshots (`images.autoResize`, on by default).
			const resized = image("A".repeat(Math.ceil((500 * 1024) / 3) * 4));
			const context: Context = {
				systemPrompt: [],
				tools: [],
				messages: Array.from({ length: 1_000 }, (_, index) => ({
					role: "user",
					content: [resized],
					timestamp: index,
				})),
			};

			const kept = imageData(clampProviderContextImages(context, model));

			expect(clampProviderContextImageBytes(context, model)).toBe(context);
			expect(kept.length).toBeGreaterThan(5);
			expect(kept.reduce((bytes, data) => bytes + data.length, 0)).toBeLessThan(bodyLimit);
		},
	);

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		const kept = imageData(clamped);
		expect(kept.length).toBeLessThanOrEqual(10);
		expect(kept).toEqual(imageData(context).slice(-kept.length));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("invalidates native replay payloads when user or developer images are clamped", () => {
		const userPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "user-native" }] }],
		};
		const developerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "developer", content: [{ type: "input_image", image_url: "dev-native" }] }],
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [image("user-image")], providerPayload: userPayload, timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], providerPayload: developerPayload, timestamp: 1 },
				...Array.from({ length: 10 }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const clampedUser = clamped.messages[0];
		const clampedDeveloper = clamped.messages[1];
		const originalUser = context.messages[0];
		const originalDeveloper = context.messages[1];

		expect(clampedUser?.role).toBe("user");
		expect(clampedDeveloper?.role).toBe("developer");
		if (
			clampedUser?.role !== "user" ||
			clampedDeveloper?.role !== "developer" ||
			originalUser?.role !== "user" ||
			originalDeveloper?.role !== "developer"
		) {
			throw new Error("Expected clamped user and developer messages");
		}
		expect(clampedUser.providerPayload).toBeUndefined();
		expect(clampedDeveloper.providerPayload).toBeUndefined();
		expect(originalUser.providerPayload).toBe(userPayload);
		expect(originalDeveloper.providerPayload).toBe(developerPayload);
		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `kept-image-${index}`));
	});

	it("does not charge assistant images against the budget user and tool result images pay", () => {
		// OpenAI budgets 200 input images per request. A Responses turn that ran
		// the image generation tool carries one `ImageContent` per
		// `image_generation_call`, and none of those are re-read as input images
		// on the next turn, so they must not consume the budget.
		const generated = Array.from({ length: 202 }, (_, index) => image(`generated-${index}`));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("draw 202 of them"), image("user-image")], timestamp: 0 },
				{
					role: "assistant",
					content: [text("here they are"), ...generated],
					api: "openai-responses",
					provider: "openai",
					model: OPENAI_RESPONSES_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "screenshot",
					content: [image("tool-image")],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_RESPONSES_MODEL);

		// 204 images total, 2 of them inputs. The clamp must leave both inputs in
		// place instead of evicting them to pay for 202 model outputs.
		expect(imageData(clamped)).toEqual(["user-image", ...generated.map(part => part.data), "tool-image"]);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(clamped.messages[2]).toBe(context.messages[2]);
	});

	it("keeps every screenshot when assistant images alone pass the cap", () => {
		const model = ANTHROPIC_PROXY_MODEL;
		const generated = Array.from({ length: 89 }, (_, index) => image(`generated-${index}`));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("first"), image("screenshot-0")], timestamp: 0 },
				{
					role: "assistant",
					content: [text("generated"), ...generated],
					api: "anthropic-messages",
					provider: "anthropic",
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: [text("second"), image("screenshot-1")], timestamp: 2 },
			],
		};

		expect(clampProviderContextImages(context, model)).toBe(context);
	});

	it("still clamps user and tool result images that genuinely exceed the cap", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("all of these"), ...Array.from({ length: 202 }, (_, index) => image(`input-${index}`))],
					timestamp: 0,
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_RESPONSES_MODEL);

		const kept = imageData(clamped);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThanOrEqual(200);
		expect(kept).toEqual(imageData(context).slice(-kept.length));
	});

	it("retains exactly the configured inline byte budget, then drops oldest images without mutating the context", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("old"), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					providerPayload: {
						type: "openaiResponsesHistory",
						items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "native" }] }],
					},
					timestamp: 0,
				},
				{ role: "developer", content: [text("middle"), image(HALF_ANTHROPIC_IMAGE_BUDGET)], timestamp: 1 },
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);

		const overBudget: Context = {
			...context,
			messages: [...context.messages, { role: "user", content: [text("new"), image("AAAA")], timestamp: 2 }],
		};
		const clamped = clampProviderContextImageBytes(overBudget, ANTHROPIC_MODEL);
		expect(clamped).not.toBe(overBudget);
		const oldTurn = clamped.messages[0];
		expect(oldTurn).toMatchObject({ role: "user", content: [text("old")], timestamp: 0 });
		expect(oldTurn?.role === "user" ? oldTurn.providerPayload : "not a user turn").toBeUndefined();
		// The clamped turn stands for the one it was copied from.
		expect(oldTurn && contextIdentity(oldTurn)).toBe(overBudget.messages[0]);
		expect(clamped.messages[1]).toBe(overBudget.messages[1]);
		expect(clamped.messages[2]).toBe(overBudget.messages[2]);
		expect(imageData(clamped)).toEqual([HALF_ANTHROPIC_IMAGE_BUDGET, "AAAA"]);
		expect(textData(clamped)).toEqual(["old", "middle", "new"]);
		expect(imageData(overBudget)).toHaveLength(3);
		expect(overBudget.messages[0]).toBe(context.messages[0]);
	});

	it("keeps the earlier request byte-identical while screenshots past the inline byte budget accumulate", () => {
		// Distinct 534 KB screenshots, one per tool result; 46 of them fill 24 MB.
		const shots = Array.from({ length: 120 }, (_, index) => `${index}:`.padEnd(534_000, "A"));
		// The text and image payloads of each tool result, as sent.
		const sentContent = (messages: Context["messages"]) =>
			messages.map(message =>
				message.role === "toolResult"
					? message.content.map(part => (part.type === "image" ? part.data : part.text))
					: [],
			);
		let previous: string[][] = [];
		let rewrites = 0;
		const added = shots.length - 46;
		for (let total = 46; total <= shots.length; total++) {
			const messages: Context["messages"] = shots.slice(0, total).map((shot, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(shot)],
				isError: false,
				timestamp: index,
			}));
			const sent = sentContent(
				clampProviderContextImageBytes({ systemPrompt: [], tools: [], messages }, ANTHROPIC_MODEL).messages,
			);
			const kept = sent.flat().filter(part => part.length === 534_000);
			expect(kept.reduce((bytes, data) => bytes + data.length, 0)).toBeLessThanOrEqual(24_000_000);
			expect(kept.at(-1)).toBe(shots[total - 1]);
			const prefix = sent.slice(0, previous.length);
			if (prefix.some((parts, index) => !Bun.deepEquals(parts, previous[index]))) rewrites++;
			previous = sent;
		}
		// Each rewrite re-sends the cached prompt; it happens once per 6 MB step, not per screenshot.
		expect(rewrites).toBeLessThanOrEqual(Math.ceil((added * 534_000) / 6_000_000));
	});

	it("removes oldest live screenshots before Anthropic's 32 MB request cap", () => {
		const screenshot = "A".repeat(534_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 62 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(screenshot)],
				isError: false,
				timestamp: index,
			})),
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		const keptImages = imageData(clamped);
		// The 9.1 MB excess over 24 MB rounds up to two 6 MB steps: the 23 oldest go.
		expect(keptImages).toHaveLength(39);
		expect(keptImages.reduce((size, data) => size + data.length, 0)).toBe(20_826_000);
		expect(clamped.messages.slice(0, 23).every(message => message.content.length === 1)).toBe(true);
		expect(clamped.messages.slice(23).every(message => message.content.length === 2)).toBe(true);
		expect(textData(clamped)).toEqual(Array.from({ length: 62 }, (_, index) => `result-${index}`));
		expect(imageData(context)).toHaveLength(62);
	});

	it("removes an oversized single tool image but keeps its tool result meaningful", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "screenshot",
					content: [image("A".repeat(24_000_004))],
					isError: false,
					timestamp: 0,
				},
			],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(imageData(context)).toHaveLength(1);
	});

	it("leaves an omission marker when an oversized image-only prompt is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [image("A".repeat(28_000_000))], timestamp: 0 }],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("does not charge URL or Anthropic file references for inline bytes", () => {
		const referenceData = "A".repeat(25_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [
						{ ...image(referenceData), url: "https://example.com/picture.png" },
						{ ...image(referenceData), providerFile: { provider: "anthropic", id: "file_123" } },
					],
					timestamp: 0,
				},
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("keeps older external references while removing later inline bytes, but still counts references", () => {
		const reference = { ...image(""), url: "https://example.com/old.png" };
		const oversized = image("A".repeat(24_000_004));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("old"), reference], timestamp: 0 },
				{ role: "user", content: [text("new"), oversized], timestamp: 1 },
			],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(clamped.messages[1]?.content).toEqual([text("new")]);
		expect(textData(clamped)).toEqual(["old", "new"]);
		expect(imageData(clamped)).toEqual([""]);
		expect(imageData(context)).toEqual(["", oversized.data]);

		const countLimited: Context = {
			...context,
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "user",
				content: [text(`ref-${index}`), { ...reference, url: `https://example.com/${index}.png` }],
				timestamp: index,
			})),
		};
		const countClamped = clampProviderContextImages(countLimited, UMANS_MODEL);
		expect(countClamped.messages[0]?.content).toEqual([text("ref-0")]);
		expect(countClamped.messages[1]?.content).toEqual([text("ref-1")]);
		expect(imageData(countClamped)).toHaveLength(9);
		expect(textData(countClamped)).toEqual(Array.from({ length: 11 }, (_, index) => `ref-${index}`));
	});

	it("does not charge assistant output images against the inline byte budget", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					api: "anthropic-messages",
					provider: "anthropic",
					model: ANTHROPIC_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: [text("look"), image("AAAA")], timestamp: 1 },
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("does not apply Anthropic's byte policy to other providers, proxies, APIs, or text-only models", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET), image("AAAA")],
					timestamp: 0,
				},
			],
		};
		expect(clampProviderContextImageBytes(context, UMANS_MODEL)).toBe(context);
		expect(clampProviderContextImageBytes(context, ANTHROPIC_PROXY_MODEL)).toBe(context);
		expect(clampProviderContextImageBytes(context, { ...ANTHROPIC_MODEL, api: "openai-responses" })).toBe(context);
		expect(clampProviderContextImageBytes(context, { ...ANTHROPIC_MODEL, input: ["text"] })).toBe(context);
	});

	it.each([
		["ANTHROPIC_BASE_URL", { ANTHROPIC_BASE_URL: "https://anthropic-proxy.example/v1" }],
		[
			"Foundry's FOUNDRY_BASE_URL",
			{ CLAUDE_CODE_USE_FOUNDRY: "1", FOUNDRY_BASE_URL: "https://foundry-proxy.example" },
		],
	] as const)("does not apply Anthropic's byte policy to an official model rerouted by %s", (_, reroute) => {
		const frame = (fill: string) => image(fill.repeat(1_600_000));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary"), frame("A"), frame("B"), frame("C")],
					historyRewriteAt: 1,
					timestamp: 0,
				},
				{
					role: "user",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					timestamp: 1,
				},
			],
		};
		const keys = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY", "FOUNDRY_BASE_URL"] as const;
		const previous = keys.map(key => [key, Bun.env[key]] as const);
		try {
			for (const key of keys) delete Bun.env[key];
			expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).not.toBe(context);
			expect(capArchiveFrameBytes(context, ANTHROPIC_MODEL)).toBe(context);
			Object.assign(Bun.env, reroute);
			expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
			// The proxy's 3 MB frame budget keeps only the newest frame.
			const capped = capArchiveFrameBytes(context, ANTHROPIC_MODEL);
			expect(imageData(capped)).toEqual([
				"C".repeat(1_600_000),
				HALF_ANTHROPIC_IMAGE_BUDGET,
				HALF_ANTHROPIC_IMAGE_BUDGET,
			]);
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});

	it("keeps images that URL decoration moved off the inline wire", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 62 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [image("A".repeat(534_000))],
				isError: false,
				timestamp: index,
			})),
		};
		const decorated = decorateContextImages(context, () => "https://images.example/frame.png");

		expect(imageData(clampProviderContextImageBytes(context, ANTHROPIC_MODEL))).toHaveLength(39);
		expect(clampProviderContextImageBytes(decorated, ANTHROPIC_MODEL)).toBe(decorated);
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});

	it("caps summary archive frames at the request model's frame budget and leaves other images alone", () => {
		const frame = (fill: string) => image(fill.repeat(1_600_000));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary"), frame("A"), frame("B"), frame("C"), text("tail")],
					historyRewriteAt: 1,
					timestamp: 1,
				},
				{ role: "user", content: [text("screenshot"), frame("D")], timestamp: 2 },
			],
		};

		const capped = capArchiveFrameBytes(context, ANTHROPIC_PROXY_MODEL);

		expect(imageData(capped).map(data => data[0])).toEqual(["C", "D"]);
		const [summary] = capped.messages;
		if (summary?.role !== "user" || !Array.isArray(summary.content)) throw new Error("Expected the summary message");
		expect(summary.content.map(block => block.type)).toEqual(["text", "text", "image", "text"]);
		expect(textData(capped)).toContainEqual(expect.stringContaining("2 archived image frames could not be included"));
		// The capped summary stands for the one it was copied from.
		expect(contextIdentity(summary)).toBe(context.messages[0]);
		expect(capArchiveFrameBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});
});
