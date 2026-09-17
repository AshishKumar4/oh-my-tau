import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createGallerySession } from "@oh-my-pi/pi-coding-agent/cli/gallery-fixtures/preview-session";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StatusLineTestComponents } from "./helpers/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";

const statusLines = new StatusLineTestComponents();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	statusLines.dispose();
	resetSettingsForTest();
});

function cacheTurn(input: number, cacheRead: number, cacheWrite: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `turn ${timestamp}` }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-opus-5",
		usage: {
			input,
			output: 10,
			cacheRead,
			cacheWrite,
			totalTokens: input + cacheRead + cacheWrite + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function sessionWithTurns(turns: Array<[number, number, number]>): AgentSession {
	const session = createGallerySession();
	turns.forEach(([input, cacheRead, cacheWrite], index) => {
		session.messages.push(cacheTurn(input, cacheRead, cacheWrite, index + 1));
	});
	return session;
}

function topBorder(session: AgentSession, width: number): string {
	const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: ["session_name"],
		separator: "powerline-thin",
		sessionAccent: false,
		contextLine: "embedded",
	});
	return stripVTControlCharacters(component.getTopBorder(width).content);
}

const WARM_SESSION: Array<[number, number, number]> = [
	[4, 17124, 10431],
	[2, 27555, 95],
	[2, 27650, 170],
	[2, 27900, 156],
	[2, 28292, 140],
];

describe("prompt-cache health indicator", () => {
	it("sits right of the context bar once the sample floor is met", () => {
		const border = topBorder(sessionWithTurns(WARM_SESSION), 120);
		expect(border).toContain("cache 91% ema / 100% p95");
		const cacheIndex = border.indexOf("cache 91%");
		expect(cacheIndex).toBeGreaterThan(border.indexOf("200K"));
		expect(cacheIndex).toBeLessThan(border.indexOf("gallery"));
	});

	it("is absent without samples", () => {
		expect(topBorder(createGallerySession(), 120)).not.toContain("cache");
	});

	it("holds a placeholder below the sample floor", () => {
		const border = topBorder(sessionWithTurns(WARM_SESSION.slice(0, 2)), 120);
		expect(border).toContain("cache …");
		expect(border).not.toContain("ema");
	});

	it("degrades to nothing when the terminal is too narrow", () => {
		expect(topBorder(sessionWithTurns(WARM_SESSION), 40)).not.toContain("cache");
	});
});
