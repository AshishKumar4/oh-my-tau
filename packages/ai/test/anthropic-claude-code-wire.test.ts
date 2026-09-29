/**
 * Contract: under the claude-code harness profile the Anthropic wire claims the
 * release of the capture it serves, and per-spawn subagent text stays out of
 * the anchored head.
 *
 * - User-Agent and billing-header `cc_version` carry the served capture's
 *   `clientVersion`; `PI_AI_CLAUDE_CODE_VERSION` still wins, requests that
 *   serve no capture keep the pinned default, and a server-demanded minimum
 *   raises an older capture version without ever lowering a newer one.
 * - `SUBAGENT_VOLATILE_MARKER` moves the claude-code head breakpoint in front
 *   of the per-spawn text so sibling subagents share the vendor prompt, footer
 *   and project context byte for byte. Native requests only lose the marker:
 *   their bytes and breakpoints match a prompt rendered without it.
 *
 * No network: a recording `fetch` answers every request with a canned turn.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams, TextBlockParam } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import {
	adoptRequiredClaudeCodeVersion,
	claudeCodeCaptureVersion,
	claudeCodeSystemInstruction,
	DEFAULT_CLAUDE_CODE_VERSION,
	getClaudeCodeVersion,
	resetAdoptedClaudeCodeVersion,
	SUBAGENT_VOLATILE_MARKER,
} from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import type { Context, FetchImpl, Model, Tool, UserMessage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";
import { anthropicTurnFetch } from "./helpers/harness-golden";

/** Opus 5.5 carries the claude-code catalog profile; Sonnet 4.5 carries none. */
const PROFILED_MODEL = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5-5");
const UNPROFILED_MODEL = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");

/**
 * `clientVersion` of the 2.1.284 capture: the billing header's `cc_version`,
 * whose suffix fingerprints the recording's first prompt, "hello". A request
 * whose first user message is "hello" recomputes that same suffix.
 */
const CAPTURE_CLIENT_VERSION = "2.1.284.b93";
const RECORDED_PROMPT = "hello";

const HEAD_TTL = { type: "ephemeral", ttl: "1h" } as const;

const TOOLS: Tool[] = [
	{
		name: "lookup",
		description: "Lookup a value",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
];

const VENDOR_PROMPT = "You are an interactive agent that helps users with software engineering tasks.";
const FOOTER = "# Environment\nSkills: none. Rules: none.";
const PROJECT_CONTEXT = "<project-context>\n<workstation>\n- cwd: /work/a\n</workstation>\n</project-context>";
const MEMORIES = "<memories>\nrecall\n</memories>";
const perSpawnText = (spawn: number) => `§ Context\nImplement part ${spawn}.\n\n# Peers\n- \`Sibling${spawn}\``;

interface WireRequest {
	userAgent: string | null;
	body: MessageCreateParams;
}

/** Streams one turn and returns every request the transport sent, in order. */
async function send(
	context: Context,
	options: AnthropicOptions = {},
	model: Model<"anthropic-messages"> = PROFILED_MODEL,
	respond: FetchImpl = anthropicTurnFetch(),
): Promise<WireRequest[]> {
	const requests: WireRequest[] = [];
	const fetch: FetchImpl = async (input, init) => {
		requests.push({
			userAgent: new Headers(init?.headers).get("User-Agent"),
			body: JSON.parse(await new Response(init?.body).text()) as MessageCreateParams,
		});
		return respond(input, init);
	};
	await streamAnthropic(model, context, { apiKey: "sk-ant-oat-test", isOAuth: true, fetch, ...options }).result();
	if (requests.length === 0) throw new Error("no /v1/messages request was sent");
	return requests;
}

function systemBlocks(body: MessageCreateParams): TextBlockParam[] {
	const system = body.system;
	if (!Array.isArray(system)) return [];
	return system.filter((block): block is TextBlockParam => typeof block !== "string");
}

/** The `cc_version` the billing header claims, suffix included. */
function billedVersion(body: MessageCreateParams): string | undefined {
	return /cc_version=([^;]+);/.exec(systemBlocks(body)[0]?.text ?? "")?.[1];
}

function anchoredTexts(body: MessageCreateParams): string[] {
	return systemBlocks(body).flatMap(block => (block.cache_control != null ? [block.text] : []));
}

function turn(text: string): Context["messages"] {
	return [{ role: "user", content: text, timestamp: 1 }];
}

withOfficialAnthropicEndpoint();

// The version a request claims also reads the env pin and a process-wide
// adopted floor; start and leave every test with neither.
let pinnedVersion: string | undefined;
beforeEach(() => {
	pinnedVersion = Bun.env.PI_AI_CLAUDE_CODE_VERSION;
	delete Bun.env.PI_AI_CLAUDE_CODE_VERSION;
	resetAdoptedClaudeCodeVersion();
});
afterEach(() => {
	if (pinnedVersion === undefined) delete Bun.env.PI_AI_CLAUDE_CODE_VERSION;
	else Bun.env.PI_AI_CLAUDE_CODE_VERSION = pinnedVersion;
	resetAdoptedClaudeCodeVersion();
});

describe("claude-code wire version", () => {
	it("reads the release out of a capture's clientVersion", () => {
		expect(claudeCodeCaptureVersion(CAPTURE_CLIENT_VERSION)).toBe("2.1.284");
		expect(claudeCodeCaptureVersion(" 2.1.269.517 ")).toBe("2.1.269");
		expect(claudeCodeCaptureVersion("2.1.267")).toBe("2.1.267");
		expect(claudeCodeCaptureVersion("bundled")).toBeUndefined();
		expect(claudeCodeCaptureVersion("2.1.284.b93.x")).toBeUndefined();
		expect(claudeCodeCaptureVersion(undefined)).toBeUndefined();
	});

	it("claims the served capture's clientVersion in the billing header and User-Agent", async () => {
		const [request] = await send(
			{ systemPrompt: [VENDOR_PROMPT], messages: turn(RECORDED_PROMPT), tools: TOOLS },
			{ harnessClientVersion: CAPTURE_CLIENT_VERSION },
		);
		expect(billedVersion(request.body)).toBe(CAPTURE_CLIENT_VERSION);
		expect(request.userAgent).toBe("claude-cli/2.1.284 (external, cli)");
	});

	it("seeds the fingerprint with the user's words under the profile, the message as sent otherwise", async () => {
		const reminder =
			"<system-reminder>\nToday: 2026-09-29; current working directory: '/work/a'.\n</system-reminder>";
		const billed = async (content: UserMessage["content"], options: AnthropicOptions = {}) => {
			const [request] = await send(
				{ systemPrompt: [VENDOR_PROMPT], messages: [{ role: "user", content, timestamp: 1 }], tools: TOOLS },
				{ harnessClientVersion: CAPTURE_CLIENT_VERSION, ...options },
			);
			return billedVersion(request.body);
		};
		// omp prepends its date/cwd reminder to the first user turn; Claude Code
		// sends its reminders as separate blocks ahead of the user's text.
		expect(await billed(`${reminder}\n\n${RECORDED_PROMPT}`)).toBe(CAPTURE_CLIENT_VERSION);
		expect(
			await billed([
				{ type: "text", text: reminder },
				{ type: "text", text: RECORDED_PROMPT },
			]),
		).toBe(CAPTURE_CLIENT_VERSION);
		// Native requests keep hashing the first text as sent: the reminder alone
		// seeds the same fingerprint as the reminder followed by the prompt.
		const native: AnthropicOptions = { harnessProfile: null };
		expect(await billed(`${reminder}\n\n${RECORDED_PROMPT}`, native)).toBe(await billed(reminder, native));
	});

	it("claims it on a model the profile is forced onto, and through streamSimple", async () => {
		const [forced] = await send(
			{ systemPrompt: [VENDOR_PROMPT], messages: turn(RECORDED_PROMPT), tools: TOOLS },
			{ harnessProfile: "claude-code", harnessClientVersion: CAPTURE_CLIENT_VERSION },
			UNPROFILED_MODEL,
		);
		expect(billedVersion(forced.body)).toBe(CAPTURE_CLIENT_VERSION);
		expect(forced.userAgent).toBe("claude-cli/2.1.284 (external, cli)");

		const requests: WireRequest[] = [];
		const respond = anthropicTurnFetch();
		await streamSimple(
			PROFILED_MODEL,
			{ systemPrompt: [VENDOR_PROMPT], messages: turn(RECORDED_PROMPT), tools: TOOLS },
			{
				apiKey: "sk-ant-oat-test",
				harnessClientVersion: CAPTURE_CLIENT_VERSION,
				fetch: async (input, init) => {
					requests.push({
						userAgent: new Headers(init?.headers).get("User-Agent"),
						body: JSON.parse(await new Response(init?.body).text()) as MessageCreateParams,
					});
					return respond(input, init);
				},
			},
		).result();
		expect(requests).toHaveLength(1);
		expect(billedVersion(requests[0].body)).toBe(CAPTURE_CLIENT_VERSION);
		expect(requests[0].userAgent).toBe("claude-cli/2.1.284 (external, cli)");
	});

	it("lets PI_AI_CLAUDE_CODE_VERSION win over the served capture", async () => {
		await withEnv({ PI_AI_CLAUDE_CODE_VERSION: "9.9.9" }, async () => {
			const [request] = await send(
				{ systemPrompt: [VENDOR_PROMPT], messages: turn(RECORDED_PROMPT), tools: TOOLS },
				{ harnessClientVersion: CAPTURE_CLIENT_VERSION },
			);
			expect(billedVersion(request.body)).toStartWith("9.9.9.");
			expect(request.userAgent).toBe("claude-cli/9.9.9 (external, cli)");
		});
	});

	it("keeps the pinned default when no Claude Code capture is served", async () => {
		const cases: readonly { options: AnthropicOptions; why: string }[] = [
			{ options: {}, why: "no capture served" },
			{ options: { harnessProfile: null, harnessClientVersion: CAPTURE_CLIENT_VERSION }, why: "native mode" },
			{ options: { harnessProfile: "codex", harnessClientVersion: CAPTURE_CLIENT_VERSION }, why: "foreign profile" },
			{ options: { harnessClientVersion: "bundled" }, why: "bundled prompt, no Claude Code release" },
		];
		for (const { options, why } of cases) {
			const [request] = await send(
				{ systemPrompt: [VENDOR_PROMPT], messages: turn(RECORDED_PROMPT), tools: TOOLS },
				options,
			);
			expect({ why, version: billedVersion(request.body)?.split(".").slice(0, 3).join(".") }).toEqual({
				why,
				version: DEFAULT_CLAUDE_CODE_VERSION,
			});
			expect({ why, userAgent: request.userAgent }).toEqual({
				why,
				userAgent: `claude-cli/${DEFAULT_CLAUDE_CODE_VERSION} (external, cli)`,
			});
		}
	});

	it("retries a version rejection at the server's minimum, headers and billing alike", async () => {
		const tooOld = JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Claude Code 2.1.284 does not support this model; version 100.0.0 or newer is required.",
				details: { error_code: "claude_code_version_too_old" },
			},
		});
		const turnResponse = anthropicTurnFetch();
		let calls = 0;
		const respond: FetchImpl = async (input, init) => {
			calls++;
			if (calls === 1) {
				return new Response(tooOld, { status: 400, headers: { "Content-Type": "application/json" } });
			}
			return turnResponse(input, init);
		};
		const requests = await send(
			{ systemPrompt: [VENDOR_PROMPT], messages: turn(RECORDED_PROMPT), tools: TOOLS },
			{ harnessClientVersion: CAPTURE_CLIENT_VERSION },
			PROFILED_MODEL,
			respond,
		);
		expect(requests).toHaveLength(2);
		expect(requests[0].userAgent).toBe("claude-cli/2.1.284 (external, cli)");
		expect(billedVersion(requests[0].body)).toBe(CAPTURE_CLIENT_VERSION);
		expect(requests[1].userAgent).toBe("claude-cli/100.0.0 (external, cli)");
		expect(billedVersion(requests[1].body)).toStartWith("100.0.0.");
	});

	it("treats an adopted minimum as a floor under the capture and the env pin as final", async () => {
		const rejection = (required: string) =>
			new Error(`claude_code_version_too_old: version ${required} or newer is required`);
		// Adopted by a request serving no capture: it replaces the default, but a
		// newer capture still claims its own release.
		expect(adoptRequiredClaudeCodeVersion(rejection("100.0.2"))).toBe(true);
		expect(getClaudeCodeVersion()).toBe("100.0.2");
		expect(getClaudeCodeVersion("100.0.5.abc")).toBe("100.0.5");
		// Rejected at the capture's own release: the floor rises past it.
		expect(adoptRequiredClaudeCodeVersion(rejection("100.0.9"), "100.0.5.abc")).toBe(true);
		expect(getClaudeCodeVersion("100.0.5.abc")).toBe("100.0.9");
		expect(getClaudeCodeVersion()).toBe("100.0.9");
		// The same demand again is terminal, not a retry loop.
		expect(adoptRequiredClaudeCodeVersion(rejection("100.0.9"), "100.0.5.abc")).toBe(false);
		await withEnv({ PI_AI_CLAUDE_CODE_VERSION: "7.7.7" }, () => {
			expect(getClaudeCodeVersion("100.0.5.abc")).toBe("7.7.7");
			expect(adoptRequiredClaudeCodeVersion(rejection("200.0.0"), "100.0.5.abc")).toBe(false);
		});
	});
});

describe("claude-code head breakpoint and per-spawn subagent text", () => {
	const sibling = (spawn: number) =>
		send({
			systemPrompt: [
				VENDOR_PROMPT,
				FOOTER,
				PROJECT_CONTEXT,
				`${SUBAGENT_VOLATILE_MARKER}\n${perSpawnText(spawn)}`,
				MEMORIES,
			],
			messages: turn(`Implement part ${spawn}`),
			tools: TOOLS,
		});

	it("anchors the head before the per-spawn text and keeps the identity slot", async () => {
		const [{ body }] = await sibling(1);
		const system = systemBlocks(body);
		expect(system.map(block => block.text).slice(1)).toEqual([
			claudeCodeSystemInstruction,
			VENDOR_PROMPT,
			FOOTER,
			PROJECT_CONTEXT,
			perSpawnText(1),
			MEMORIES,
		]);
		expect(anchoredTexts(body)).toEqual([claudeCodeSystemInstruction, PROJECT_CONTEXT]);
		expect(system[4]?.cache_control).toEqual(HEAD_TTL);
		expect(system[5]?.cache_control).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain(SUBAGENT_VOLATILE_MARKER);
		expect(body.tools?.some(tool => tool.cache_control != null)).toBe(false);
	});

	it("gives sibling subagents a byte-identical anchored head", async () => {
		const [{ body: first }] = await sibling(1);
		const [{ body: second }] = await sibling(2);
		const firstSystem = systemBlocks(first);
		const secondSystem = systemBlocks(second);
		const anchor = firstSystem.findLastIndex(block => block.cache_control != null);
		expect(firstSystem[anchor]?.text).toBe(PROJECT_CONTEXT);
		expect(secondSystem.findLastIndex(block => block.cache_control != null)).toBe(anchor);
		// Block 0 is the billing header, whose attestation hashes the whole body.
		expect(JSON.stringify(secondSystem.slice(1, anchor + 1))).toBe(JSON.stringify(firstSystem.slice(1, anchor + 1)));
		expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
		expect(secondSystem[anchor + 1]?.text).not.toBe(firstSystem[anchor + 1]?.text);
	});

	it("splits a block at an inline marker so the text before it stays anchored", async () => {
		const [{ body }] = await send({
			systemPrompt: [VENDOR_PROMPT, FOOTER, `Role: reviewer.\n\n${SUBAGENT_VOLATILE_MARKER}\n${perSpawnText(7)}`],
			messages: turn("Review part 7"),
			tools: TOOLS,
		});
		expect(
			systemBlocks(body)
				.map(block => block.text)
				.slice(1),
		).toEqual([claudeCodeSystemInstruction, VENDOR_PROMPT, FOOTER, "Role: reviewer.", perSpawnText(7)]);
		expect(anchoredTexts(body)).toEqual([claudeCodeSystemInstruction, "Role: reviewer."]);
	});

	it("leaves native requests byte-identical to a prompt rendered without the marker", async () => {
		for (const auth of [
			{ apiKey: "sk-ant-oat-test", isOAuth: true },
			{ apiKey: "sk-ant-api-test", isOAuth: false },
		]) {
			const options: AnthropicOptions = { harnessProfile: null, ...auth };
			const context = (perSpawn: string): Context => ({
				systemPrompt: [VENDOR_PROMPT, FOOTER, PROJECT_CONTEXT, perSpawn, MEMORIES],
				messages: turn("Implement part 1"),
				tools: TOOLS,
			});
			const [{ body: marked }] = await send(context(`${SUBAGENT_VOLATILE_MARKER}\n${perSpawnText(1)}`), options);
			const [{ body: plain }] = await send(context(perSpawnText(1)), options);
			// With OAuth, block 0 is the billing header, whose attestation hashes the
			// whole body (including a per-request metadata id).
			const skip = auth.isOAuth ? 1 : 0;
			expect(JSON.stringify(systemBlocks(marked).slice(skip))).toBe(JSON.stringify(systemBlocks(plain).slice(skip)));
			expect(JSON.stringify(marked.tools)).toBe(JSON.stringify(plain.tools));
			expect(JSON.stringify(marked.messages)).toBe(JSON.stringify(plain.messages));
			// Native anchors the block before `<project-context>` plus the last tool.
			expect(anchoredTexts(marked)).toEqual([FOOTER]);
			expect(marked.tools?.map(tool => tool.cache_control != null)).toEqual([true]);
		}
	});
});
