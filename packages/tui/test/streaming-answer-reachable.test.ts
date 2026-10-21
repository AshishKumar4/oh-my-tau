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

function reply(text: string | readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: (typeof text === "string" ? [text] : text).map(block => ({ type: "text" as const, text: block })),
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

/** A running composer with a streaming assistant answer above `chrome` and an editor. */
async function mount({ realEditor = false, columns = 60 }: { realEditor?: boolean; columns?: number } = {}) {
	const terminal = new VirtualTerminal(columns, 18);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	const hud = new Hud();
	const editor = new Container();
	editor.addChild(realEditor ? composer.editor : new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, hud, editor], { transientChrome: [editor] });
	composer.start({ playWelcomeIntro: false });
	await scheduler.settle(terminal);
	composer.setRunActive(true);
	const message = new AssistantMessageComponent();
	transcript.addChild(message);
	const paint = async (text: string | readonly string[]): Promise<void> => {
		message.updateContent(reply(text), { transient: true });
		composer.ui.requestRender();
		await scheduler.settle(terminal);
	};
	/** Finalizes the answer and ends the run. */
	const finish = async (text: string | readonly string[]): Promise<void> => {
		message.updateContent(reply(text));
		message.markTranscriptBlockFinalized();
		composer.setRunActive(false);
		composer.ui.requestRender();
		await scheduler.advance(terminal, 300);
	};
	return { terminal, scheduler, composer, hud, editor, message, paint, finish };
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

for (const kind of ["list", "hud", "composer", "batched paragraphs", "paragraph control"] as const) {
	it(`keeps the latest answer reachable in screen plus native scrollback: ${kind}`, async () => {
		const { terminal, scheduler, composer, hud, editor, paint, finish } = await mount({
			realEditor: kind === "composer",
		});
		try {
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
				// Two deliveries of the same answer, with many stable boundaries
				// between paints, must not make those boundaries indivisible.
				if (kind === "batched paragraphs" && count > 1 && count < lines.length) continue;
				if (count === 24 && kind === "hud") hud.rows = 6;
				if (count === 24 && kind === "composer")
					composer.editor.setText(Array.from({ length: 7 }, () => "draft input").join("\n"));
				await paint(text(count));
			}
			const live = inspect(terminal);
			await finish(text(48));
			const ended = inspect(terminal);
			hud.rows = 0;
			if (kind === "composer") composer.editor.setText("");
			else {
				editor.clear();
				editor.addChild(new Text("EDITOR", 0, 0));
			}
			composer.ui.requestRender();
			await scheduler.advance(terminal, 300);
			const shrunk = inspect(terminal);
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

const marker = (index: number): string => `QZ${String(index + 1).padStart(3, "0")}`;

// Content 10 cells wide: `alpha beta xy` wraps after `beta`. A cut that lost the
// CRs' offsets lands right there, which reads as a row prefix at this width and
// is not one at the next. A live block of a few paragraphs retires that cut while
// `xy` is still on screen when the terminal widens.
for (const live of [5, 6, 7, 8]) {
	it(`keeps CRLF paragraphs whole across a resize when one paint closes them (${live} live paragraphs)`, async () => {
		const { terminal, scheduler, composer, paint, finish } = await mount({ columns: 12 });
		try {
			const closed = "P\r\n\r\nQ\r\n\r\nalpha beta xy\n\nTail";
			const streaming = Array.from({ length: live }, (_, i) => marker(i)).join("\n\n");
			await paint("P");
			// One paint closes the CRLF block while a second block streams below it.
			await paint([closed, `${streaming}\n\nstill writing`]);
			terminal.resize(22, 18);
			composer.ui.requestRender();
			await scheduler.advance(terminal, 200);
			await finish([closed, streaming]);
			const reachable = terminal.getScrollBuffer().map(row => Bun.stripANSI(row));
			expect(reachable.filter(row => /\bxy\b/.test(row))).toHaveLength(1);
		} finally {
			composer.stop();
		}
	});
}
