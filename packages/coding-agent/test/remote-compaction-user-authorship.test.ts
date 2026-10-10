import { expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	compact,
	countResponsesHistoryTokens,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getCompactionV2PreserveData,
	type CompactionPreparation,
} from "@oh-my-pi/pi-agent-core/compaction";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { convertToLlm, isUserAuthoredMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { COLLAB_PROMPT_MESSAGE_TYPE, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-tui/chat/messages";

it("retains operator skill and collab prompts with images without retaining generated user-role notices", async () => {
	const image = "a".repeat(320_000);
	const preparation: CompactionPreparation = {
		firstKeptEntryId: "kept",
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteStreamingV2Enabled: true },
		messagesToSummarize: [
			{ role: "user", content: "User question", timestamp: 1 },
			{
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				attribution: "user",
				content: "Operator skill request",
				display: true,
				timestamp: 2,
			},
			{
				role: "custom",
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				attribution: "user",
				content: "Operator collab request",
				display: true,
				timestamp: 3,
			},
			{
				role: "custom",
				customType: "fixture-notice",
				attribution: "user",
				content: "Generated side notice",
				display: false,
				timestamp: 4,
			},
			{
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				attribution: "agent",
				content: "Auto loaded skill",
				display: false,
				timestamp: 5,
			},
			{ role: "user", attribution: "agent", content: "Continue automatically", timestamp: 6 },
		],
		turnPrefixMessages: [],
		recentMessages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "See operator image" },
					{ type: "image", data: image, mimeType: "image/png" },
				],
				timestamp: 7,
			},
		],
	};
	const model = buildModel({
		id: "gpt-5.6-sol",
		name: "Compaction fixture",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 8192,
		remoteCompaction: { enabled: true, v2StreamingEnabled: true },
	});
	const output = { type: "compaction", encrypted_content: "fixture-encrypted" };
	let sent = "";
	const result = await compact(preparation, model, "fixture", undefined, undefined, {
		convertToLlm,
		isUserAuthored: isUserAuthoredMessage,
		fetch: async (_url, request) => {
			sent = String(request?.body);
			return new Response(
				[
					{ type: "response.output_item.done", output_index: 0, item: output },
					{
						type: "response.completed",
						response: { usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } },
					},
				]
					.map(event => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const preserved = getCompactionV2PreserveData(result.preserveData);
	if (!preserved) throw new Error("Expected replacement history");
	const history = JSON.stringify(preserved.replacementHistory);
	expect(history).toContain("User question");
	expect(history).toContain("Operator skill request");
	expect(history).toContain("Operator collab request");
	expect(history).toContain(image);
	expect(history).not.toContain("Generated side notice");
	expect(history).not.toContain("Auto loaded skill");
	expect(history).not.toContain("Continue automatically");
	expect(sent).toContain("Generated side notice");
	const retainedImages = preserved.replacementHistory.flatMap(item =>
		Array.isArray(item.content) ? item.content.filter(isRecord).filter(part => part.type === "input_image") : [],
	);
	expect(retainedImages).toHaveLength(1);
	expect(retainedImages[0]?.image_url).toBe(`data:image/png;base64,${image}`);
	const tokenizer = new Tokenizer();
	expect(countResponsesHistoryTokens(preserved.replacementHistory, tokenizer)).toBeLessThan(
		tokenizer.countTokens(history),
	);
	expect(preserved.replacementHistory.at(-1)).toEqual(output);
});
