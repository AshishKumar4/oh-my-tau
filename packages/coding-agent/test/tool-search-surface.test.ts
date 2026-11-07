import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	claudeCodeBillingHeaderPrefix,
	claudeCodeEntrypoint,
	claudeCodeSystemInstruction,
} from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HARNESS_CAPTURE_SCHEMA } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { withHarnessCacheDir } from "./helpers/harness";

// Claude Code 2.1.319 defers tools behind ToolSearch. Under a capture of that
// client, omp defers its discoverable tools (and the client's own, like
// WebSearch) the same way: announced by name in the client's words, declared
// with `defer_loading`, and loaded by a search whose result references them.

const CLIENT_VERSION = "2.1.319.test";
const OPUS = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5-5");
const ANNOUNCEMENT =
	'The following deferred tools are now available via ToolSearch. Use ToolSearch with query "select:<name>" to load them:';
const HARNESS_PROMPT = "\nYou are an interactive agent that helps users with software engineering tasks.";

interface MessagesRequest {
	system: Array<{ text: string }>;
	tools: Array<{ name: string; defer_loading?: boolean }>;
	messages: Array<{ role: string; content: unknown }>;
}

function sse(events: Record<string, unknown>[]): Response {
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function reply(turn: number, call?: { name: string; input: Record<string, unknown> }): Response {
	const start = {
		type: "message_start",
		message: {
			id: `msg_${turn}`,
			type: "message",
			role: "assistant",
			content: [],
			model: OPUS.id,
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	};
	const block = call
		? [
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: `toolu_${turn}`, name: call.name, input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
				},
			]
		: [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
			];
	return sse([
		start,
		...block,
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	]);
}

async function seedCapture(cache: string, toolSearch: boolean): Promise<void> {
	const dir = path.join(cache, "claude-code");
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(
		path.join(dir, `${CLIENT_VERSION}-${claudeCodeEntrypoint}-${OPUS.id}.json`),
		JSON.stringify({
			schema: HARNESS_CAPTURE_SCHEMA,
			profile: "claude-code",
			clientVersion: CLIENT_VERSION,
			entrypoint: claudeCodeEntrypoint,
			capturedAt: new Date().toISOString(),
			model: OPUS.id,
			instructions: [
				`${claudeCodeBillingHeaderPrefix} cc_version=${CLIENT_VERSION}; cc_entrypoint=${claudeCodeEntrypoint};`,
				claudeCodeSystemInstruction,
				HARNESS_PROMPT,
			],
			tools: ["Bash", "Read", ...(toolSearch ? ["ToolSearch"] : [])],
			declarations: [],
			...(toolSearch && { toolSearch: { announcement: ANNOUNCEMENT, deferred: ["CronList", "WebSearch"] } }),
		}),
	);
}

describe("tool search under a Claude Code capture that defers tools", () => {
	const dirs = withHarnessCacheDir("omp-tool-search-");
	const previousProxy = Bun.env.PI_PROXY_ANTHROPIC;
	const previousThreads = Bun.env.PI_ANTHROPIC_MESSAGE_THREADS;
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-tool-search-");
		// A provider proxy moves first-party requests onto `globalThis.fetch`, where the spy answers them.
		Bun.env.PI_PROXY_ANTHROPIC = "http://proxy.example.test:8080";
		// Each request carries its full body, so every one shows the declared tools.
		Bun.env.PI_ANTHROPIC_MESSAGE_THREADS = "0";
		__resetProxyCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
		if (previousProxy === undefined) delete Bun.env.PI_PROXY_ANTHROPIC;
		else Bun.env.PI_PROXY_ANTHROPIC = previousProxy;
		if (previousThreads === undefined) delete Bun.env.PI_ANTHROPIC_MESSAGE_THREADS;
		else Bun.env.PI_ANTHROPIC_MESSAGE_THREADS = previousThreads;
		__resetProxyCache();
	});

	async function run(
		toolSearch: boolean,
		script: Array<{ name: string; input: Record<string, unknown> } | undefined>,
	) {
		await seedCapture(dirs.cache, toolSearch);
		await Bun.write(tempDir.join("main.ts"), "export const answer = 42;\n");
		const requests: MessagesRequest[] = [];
		const betas: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).startsWith("https://api.anthropic.com/v1/messages")) {
					throw new Error(`Unexpected request to ${String(input)}`);
				}
				const body = JSON.parse(requestBodyText(init) ?? "{}") as MessagesRequest & { tools?: unknown[] };
				// Side requests (titles) declare no tools.
				if (!body.tools || body.tools.length === 0) return reply(0);
				requests.push(body);
				betas.push(new Headers(init?.headers).get("anthropic-beta") ?? "");
				return reply(requests.length, script[requests.length - 1]);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "harness.mode": "auto" }),
			model: OPUS,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			await session.prompt("find usages of foo");
			await session.waitForIdle();
		} finally {
			await session.dispose();
			authStorage.close();
		}
		return { requests, betas };
	}

	it("announces deferred tools, loads one through ToolSearch, and runs it", async () => {
		const { requests, betas } = await run(true, [
			{ name: "ToolSearch", input: { query: "select:ast_edit", max_results: 5 } },
			{ name: "ast_edit", input: { ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["."] } },
			undefined,
		]);
		expect(requests).toHaveLength(3);
		const [first, second, third] = requests;

		// Deferred tools ride the request with defer_loading; ToolSearch is loaded.
		const declared = new Map(first.tools.map(tool => [tool.name, tool.defer_loading === true]));
		expect(declared.get("ToolSearch")).toBe(false);
		expect(declared.get("ast_edit")).toBe(true);
		expect(declared.get("WebSearch")).toBe(true);
		expect(declared.get("Bash")).toBe(false);
		// The prompt names them in the client's words and has no xd:// devices.
		const system = first.system.map(block => block.text).join("\n");
		const announced = system.slice(system.indexOf(ANNOUNCEMENT)).split("\n");
		expect(announced[0]).toBe(ANNOUNCEMENT);
		expect(announced).toContain("ast_edit");
		expect(announced).toContain("WebSearch");
		expect(system).not.toContain("xd://");

		// The search's result references the tool; the declared tools do not change.
		expect(second.tools).toEqual(first.tools);
		expect(second.messages.at(-1)?.content).toEqual([
			expect.objectContaining({ type: "tool_result", content: [{ type: "tool_reference", tool_name: "ast_edit" }] }),
			expect.objectContaining({ type: "text", text: "Tool loaded." }),
		]);

		// The loaded tool runs.
		const ran = third.messages.at(-1)?.content;
		expect(ran).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_2" })]);
		expect(JSON.stringify(ran)).not.toContain('"is_error":true');
		for (const header of betas) expect(header.split(",")).toContain("advanced-tool-use-2025-11-20");
	});

	it("keeps xd:// devices under a capture without tool search", async () => {
		const { requests } = await run(false, [undefined]);
		const [first] = requests;
		expect(first.tools.some(tool => tool.defer_loading === true)).toBe(false);
		expect(first.tools.some(tool => tool.name === "ToolSearch")).toBe(false);
		expect(first.system.map(block => block.text).join("\n")).toContain("xd://");
	});
});
