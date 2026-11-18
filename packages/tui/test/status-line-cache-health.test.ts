import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import type { PromptCacheHealthText, StatusLineHost, StatusLineSession } from "@oh-my-pi/pi-tui/status-line/host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

// The status line's prompt-cache gauge: an EMA over every request and the P95
// of the last 100, read from the session's message feed as it grows.

interface Prompt {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

// A real five-request Claude session: a cold first request, then warm reads.
const COLD: Prompt = { input: 4, cacheRead: 17124, cacheWrite: 10431 };
const WARM: Prompt[] = [
	{ input: 2, cacheRead: 27555, cacheWrite: 95 },
	{ input: 2, cacheRead: 27650, cacheWrite: 170 },
	{ input: 2, cacheRead: 27900, cacheWrite: 156 },
	{ input: 2, cacheRead: 28292, cacheWrite: 140 },
];

function reply(prompt: Prompt): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		usage: {
			...prompt,
			output: 10,
			totalTokens: prompt.input + prompt.cacheRead + prompt.cacheWrite + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const ask: AgentMessage = { role: "user", content: [{ type: "text", text: "next" }], timestamp: 0 };

/** The gauge the status line binds onto a session showing `messages`. */
function gauge(messages: AgentMessage[]): () => PromptCacheHealthText | undefined {
	const session = {
		sessionFile: undefined,
		isStreaming: false,
		messages,
		state: { model: undefined, messages },
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
	const host = {
		getSettings: () => ({}),
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => null,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: () => Promise.resolve(null),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
		lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 0 }),
		resolveActiveRepo: () => null,
	} as unknown as StatusLineHost<StatusLineSession>;
	new StatusLineComponent(session, host);
	const read = session.promptCacheHealthText;
	if (!read) throw new Error("the status line binds the gauge to its session");
	return () => read();
}

describe("status-line prompt-cache gauge", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("holds a placeholder until five requests, then shows the EMA and the P95", () => {
		const messages: AgentMessage[] = [];
		const read = gauge(messages);
		expect(read()).toBeUndefined();
		messages.push(ask, reply(COLD), ask, reply(WARM[0]));
		expect(read()).toEqual({ full: "cache …" });
		for (const prompt of WARM.slice(1)) messages.push(ask, reply(prompt));
		// EMA(0.3) climbs from the cold 62% to 91%; the warm reads put P95 at 100%.
		expect(read()).toEqual({ full: "cache 91% ema / 100% p95", compact: "cache 91/100" });
	});

	it("counts a request only when it carried prompt tokens", () => {
		const messages = [reply({ input: 0, cacheRead: 0, cacheWrite: 0 })];
		const read = gauge(messages);
		expect(read()).toBeUndefined();
		for (const prompt of WARM) messages.push(reply(prompt));
		expect(read()).toEqual({ full: "cache …" });
	});

	it("reads a replaced last message again, as a streamed reply settles", () => {
		const messages = [COLD, ...WARM].map(reply);
		const read = gauge(messages);
		expect(read()?.compact).toBe("cache 91/100");
		// The settled reply replaces the streamed one; a cold miss pulls the EMA down.
		messages[messages.length - 1] = reply({ input: 2, cacheRead: 0, cacheWrite: 28430 });
		expect(read()?.compact).toBe("cache 61/100");
		messages.length = 2;
		expect(read()).toEqual({ full: "cache …" });
	});

	it("ranks P95 over the last 100 requests, not the whole session", () => {
		const hit = { input: 0, cacheRead: 100, cacheWrite: 0 };
		const half = { input: 0, cacheRead: 50, cacheWrite: 50 };
		const messages = Array.from({ length: 20 }, () => reply(hit));
		const read = gauge(messages);
		expect(read()?.compact).toBe("cache 100/100");
		for (let index = 0; index < 100; index++) messages.push(reply(half));
		expect(read()?.compact).toBe("cache 50/50");
	});
});
