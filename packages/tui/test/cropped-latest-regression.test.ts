import { beforeAll, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "test",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

class Hud implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `HUD ${i}`);
	}
}

/** The engine exposes history followed by the active grid, not just the screen. */
function inspect(terminal: VirtualTerminal) {
	const tokens = (rows: readonly string[]): string[] =>
		rows.flatMap(row => [...Bun.stripANSI(row).matchAll(/QZ\d{3}/g)].map(match => match[0]));
	const history = tokens(terminal.getScrollBuffer().slice(0, -terminal.rows));
	const screen = tokens(terminal.getViewport());
	const counts = new Map<string, number>();
	for (const token of [...history, ...screen]) counts.set(token, (counts.get(token) ?? 0) + 1);
	const expected = Array.from({ length: 48 }, (_, i) => `QZ${String(i + 1).padStart(3, "0")}`);
	return {
		history,
		screen,
		missing: expected.filter(token => !counts.has(token)),
		duplicated: [...counts].filter(([, count]) => count > 1).map(([token]) => token),
	};
}

beforeAll(async () => {
	await initTheme();
});

for (const kind of ["list", "hud", "composer"] as const) {
	it(`keeps the latest answer reachable in screen plus native scrollback: ${kind}`, async () => {
		const terminal = new VirtualTerminal(60, 18);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const hud = new Hud();
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, hud, editor], { transientChrome: [editor] });
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			composer.setRunActive(true);
			const message = new AssistantMessageComponent();
			transcript.addChild(message);
			const lines = Array.from(
				{ length: 48 },
				(_, i) => `QZ${String(i + 1).padStart(3, "0")} alpha bravo charlie delta`,
			);
			const text = (count: number): string =>
				kind === "list"
					? lines
							.slice(0, count)
							.map(line => `- ${line}`)
							.join("\n")
					: lines.slice(0, count).join("\n\n");
			for (let count = 1; count <= lines.length; count++) {
				if (count === 24 && kind === "hud") hud.rows = 6;
				if (count === 24 && kind === "composer") editor.addChild(new Text("input\n".repeat(5), 0, 0));
				message.updateContent(reply(text(count)), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			const live = inspect(terminal);
			message.updateContent(reply(text(48)));
			message.markTranscriptBlockFinalized();
			composer.setRunActive(false);
			composer.ui.requestRender();
			await scheduler.advance(terminal, 300);
			const ended = inspect(terminal);
			hud.rows = 0;
			editor.clear();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.ui.requestRender();
			await scheduler.advance(terminal, 300);
			const shrunk = inspect(terminal);
			console.log(JSON.stringify({ kind, live, ended, shrunk }));
			// Check the end state too: this is temporary unreachability, not data deletion.
			expect({ missing: shrunk.missing, duplicated: shrunk.duplicated }).toEqual({ missing: [], duplicated: [] });
			expect(live.screen).toContain("QZ048");
			expect(live.duplicated).toEqual([]);
			if (kind === "composer") expect(ended.missing).toEqual([]);
			expect(live.missing).toEqual([]);
			expect(ended.missing).toEqual([]);
		} finally {
			composer.stop();
		}
	});
}
