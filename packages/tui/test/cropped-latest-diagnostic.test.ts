import { beforeAll, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
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

class Chrome implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `HUD ${i}`);
	}
}

function ids(rows: readonly string[]): number[] {
	return rows.flatMap(row => [...Bun.stripANSI(row).matchAll(/QZ(\d{3})/g)].map(match => Number(match[1])));
}

function snapshot(terminal: VirtualTerminal, count: number) {
	const buffer = terminal.getScrollBuffer();
	const history = ids(buffer.slice(0, -terminal.rows));
	const screen = ids(terminal.getViewport());
	const all = [...history, ...screen];
	return {
		history,
		screen,
		missing: Array.from({ length: count }, (_, i) => i + 1).filter(id => !all.includes(id)),
		duplicated: [...new Set(all.filter((id, i) => all.indexOf(id) !== i))],
	};
}

beforeAll(async () => {
	await initTheme();
});

const kinds = ["paragraphs", "single paragraph", "list", "loose list", "fence", "table"] as const;
type Kind = (typeof kinds)[number];
function source(kind: Kind, count: number, closed = false): string {
	const lines = Array.from(
		{ length: count },
		(_, i) => `QZ${String(i + 1).padStart(3, "0")} alpha bravo charlie delta`,
	);
	const following = closed ? "\n\nEnd.\n\nFollowing." : "";
	if (kind === "list") return lines.map(line => `- ${line}`).join("\n") + following;
	if (kind === "loose list") return lines.map(line => `- ${line}`).join("\n\n") + following;
	if (kind === "fence")
		return ["```text", ...lines, ...(closed ? ["```", "", "End.", "", "Following."] : [])].join("\n");
	if (kind === "table")
		return [
			"| Item |",
			"| --- |",
			...lines.map(line => `| ${line} |`),
			...(closed ? ["", "End.", "", "Following."] : []),
		].join("\n");
	return lines.join(kind === "paragraphs" ? "\n\n" : "\n") + following;
}

for (const kind of kinds) {
	for (const variant of [
		"normal",
		"narrow",
		"resize",
		"growing chrome",
		"growing composer",
		"real composer",
	] as const) {
		it(`diagnostic ${kind} / ${variant}`, async () => {
			const terminal = new VirtualTerminal(variant === "narrow" ? 24 : 60, 18, 5000);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			const transcript = new TranscriptContainer();
			const chrome = new Chrome();
			const editor = new Container();
			editor.addChild(variant === "real composer" ? composer.editor : new Text("EDITOR", 0, 0));
			composer.setRuntimeChildren([transcript, chrome, editor], { transientChrome: [editor] });
			composer.start({ playWelcomeIntro: false });
			const observations: unknown[] = [];
			let tool: ToolExecutionComponent | undefined;
			try {
				await scheduler.settle(terminal);
				composer.setRunActive(true);
				const message = new AssistantMessageComponent();
				transcript.addChild(message);
				let firstLoss: unknown;
				let lossFrames = 0;
				for (let count = 1; count <= 48; count++) {
					if (variant === "resize" && count === 24) terminal.resize(24, 18);
					if (variant === "resize" && count === 40) terminal.resize(60, 18);
					if (variant === "growing chrome" && count === 24) chrome.rows = 6;
					if (variant === "growing composer" && count === 24) editor.addChild(new Text("input\n".repeat(5), 0, 0));
					if (variant === "real composer" && count === 24)
						composer.editor.setText(Array.from({ length: 7 }, () => "draft input").join("\n"));
					message.updateContent(reply(source(kind, count)), { transient: true });
					composer.ui.requestRender();
					await scheduler.settle(terminal);
					if (variant === "resize" && [24, 40].includes(count)) {
						observations.push({ phase: `resize ${count} before 120ms settle`, ...snapshot(terminal, count) });
						await scheduler.advance(terminal, 200);
					}
					const state = snapshot(terminal, count);
					if (state.missing.length > 0) {
						lossFrames++;
						firstLoss ??= { count, ...state };
					}
					if ([24, 48].includes(count))
						observations.push({
							phase: `stream ${count}`,
							stable: message.getTranscriptStableRows().length,
							...state,
						});
				}
				observations.push({ firstLoss, lossFrames });
				message.updateContent(reply(source(kind, 48, true)), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				observations.push({ phase: "closed while transient", ...snapshot(terminal, 48) });
				message.updateContent(reply(source(kind, 48, true)));
				message.markTranscriptBlockFinalized();
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				observations.push({ phase: "message end, run active", ...snapshot(terminal, 48) });
				tool = new ToolExecutionComponent("bash", { command: "echo tool" }, {}, undefined, {
					requestRender: () => composer.ui.requestRender(),
					requestComponentRender: () => composer.ui.requestRender(),
					resetDisplay() {},
				});
				tool.setArgsComplete();
				tool.setExecutionStarted();
				transcript.addChild(tool);
				tool.updateResult({ content: [{ type: "text", text: "tool" }], details: {}, isError: false }, false);
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				observations.push({ phase: "tool after text", ...snapshot(terminal, 48) });
				composer.setRunActive(false);
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				observations.push({ phase: "turn end", ...snapshot(terminal, 48) });
				chrome.rows = 0;
				if (variant === "real composer") composer.editor.setText("");
				else {
					editor.clear();
					editor.addChild(new Text("EDITOR", 0, 0));
				}
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				const final = snapshot(terminal, 48);
				observations.push({ phase: "chrome shrunk", ...final });
				console.log(JSON.stringify({ kind, variant, observations }));
				expect({ missing: final.missing, duplicated: final.duplicated }).toEqual({ missing: [], duplicated: [] });
			} finally {
				tool?.stopAnimation();
				composer.stop();
			}
		});
	}
}
