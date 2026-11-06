/**
 * Contract: a resumed Codex turn costs what it cost before the session was
 * saved. The saved turn leaves out a thinking signature its native payload
 * carries, and the payload's encrypted reasoning still goes on the wire.
 */
import { expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const isAssistant = (message: AgentMessage): message is AssistantMessage => message.role === "assistant";

it("counts a resumed Codex turn's replayed reasoning when its backend reported no reasoning tokens", async () => {
	using tempDir = TempDir.createSync("@pi-resumed-codex-reasoning-");
	const sol = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol");
	const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "e".repeat(16_000) };
	const turn: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) },
			{ type: "text", text: "Done." },
		],
		api: sol.api,
		provider: sol.provider,
		model: sol.id,
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: sol.provider,
			dt: true,
			items: [
				reasoningItem,
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
			],
		},
		usage: {
			input: 0,
			output: 6_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const sessionDir = tempDir.join("sessions");
	const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
	sessionManager.appendMessage({ role: "user", content: "Question?", timestamp: 0 });
	sessionManager.appendMessage(turn);
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	await sessionManager.close();

	const resumed = await SessionManager.open(sessionFile, sessionDir);
	try {
		const resumedTurn = resumed.buildSessionContext().messages.find(isAssistant);
		if (!resumedTurn) throw new Error("Expected the resumed assistant turn");
		// The resumed request still sends the encrypted reasoning.
		const wire = convertCodexResponsesMessages(sol, { messages: [resumedTurn] });
		expect(wire.filter(item => item.type === "reasoning")).toHaveLength(1);
		const tokenizer = new Tokenizer(sol);
		expect(tokenizer.countMessage(resumedTurn)).toBe(tokenizer.countMessage(turn));
		expect(tokenizer.countMessage(resumedTurn)).toBeGreaterThan(
			tokenizer.countMessage(resumedTurn, { excludeEncryptedReasoning: true }),
		);
	} finally {
		await resumed.close();
	}
});
