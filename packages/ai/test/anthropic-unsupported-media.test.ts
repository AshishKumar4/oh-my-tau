import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Message, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Claude reads JPEG, PNG, GIF and WebP only. A video, PDF or HEIC attached to the
// turn being answered must fail the request, not reach the model as a text stub
// it answers as if nothing were attached.

const MODEL = buildModel({
	id: "claude-haiku-5-5",
	name: "Claude Haiku 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

let clock = 1;

function withAttachment(mimeType: string): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "what happens in this clip?" },
			{ type: "image", data: "AAAAIGZ0eXBpc29t", mimeType },
		],
		timestamp: clock++,
	};
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: clock++,
	};
}

const followUp = (): UserMessage => ({ role: "user", content: "never mind, summarize the plan", timestamp: clock++ });

describe("anthropic media Claude cannot read", () => {
	it.each(["video/mp4", "application/pdf", "image/heic"])("fails the turn that attached %s", mimeType => {
		expect(() => convertAnthropicMessages([withAttachment(mimeType)], MODEL, false)).toThrow(
			`Claude does not accept ${mimeType} attachments`,
		);
	});

	it("still sends the image types Claude reads", () => {
		const params = convertAnthropicMessages([withAttachment("image/jpg")], MODEL, false);
		expect(params.at(-1)?.content).toContainEqual({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "AAAAIGZ0eXBpc29t" },
		});
	});

	it("keeps an answered turn's attachment as a note instead of failing every later request", () => {
		const params = convertAnthropicMessages(
			[withAttachment("video/mp4"), answer("I can't see a video."), followUp()],
			MODEL,
			false,
		);
		expect(params[0]?.content).toContainEqual({
			type: "text",
			text: "[video/mp4 attachment omitted: not supported by this model]",
		});
	});

	it("reports the rejection as a stream error without sending a request", async () => {
		let sent = false;
		const message = await streamAnthropic(
			MODEL,
			{ messages: [withAttachment("video/mp4")] satisfies Message[] },
			{
				apiKey: "sk-ant-api-test",
				fetch: async () => {
					sent = true;
					return Response.json(
						{ type: "error", error: { type: "invalid_request_error", message: "unexpected request" } },
						{ status: 400 },
					);
				},
			},
		).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Claude does not accept video/mp4 attachments");
		expect(sent).toBe(false);
	});
});
