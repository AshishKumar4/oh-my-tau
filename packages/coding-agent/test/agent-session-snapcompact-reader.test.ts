/**
 * A snapcompact archive rendered under a non-Anthropic model keeps its
 * `¶think:` sections and reasoning legend. Claude refuses requests that replay
 * them (`reasoning_extraction`), so whatever brings a Claude model to such an
 * archive (a model switch, a resume, a side request) must send the archive's
 * no-reasoning view, while the original stays intact for other readers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, isRecord, setAgentDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const REASONING = "PRIVATE-REASONING";
const PLAIN_LEGEND = "`¶user:`, `¶ai:`, `¶call:`: user, assistant reply, tool call.";

function bundled(provider: GeneratedProvider, modelId: string): Model {
	const model = getBundledModel(provider, modelId);
	if (!model) throw new Error(`Expected bundled ${provider}/${modelId}`);
	return model;
}

const gpt = bundled("openai", "gpt-5.4");
const claude = bundled("anthropic", "claude-opus-5-5");

function assistant(model: Model, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

/** Archived turns long enough to image the middle even without their reasoning. */
function archivedTurns(): Message[] {
	const filler = "the quick brown fox jumps over the lazy dog. ".repeat(20);
	return Array.from({ length: 40 }, (_, i) => [
		{ role: "user" as const, content: `turn ${i}: ${filler}`, timestamp: Date.now() },
		assistant(gpt, [
			{ type: "thinking", thinking: `${REASONING} ${i}: ${filler}\n\n${REASONING} ${i} continued: ${filler}` },
			{ type: "text", text: `reply ${i}: ${filler}` },
		]),
	]).flat();
}

/** Every text block and image payload the request's user turns carry. */
function requestContent(messages: readonly Message[] | undefined): { text: string; images: string[] } {
	const texts: string[] = [];
	const images: string[] = [];
	for (const message of messages ?? []) {
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "text") texts.push(block.text);
			else images.push(block.data);
		}
	}
	return { text: texts.join("\n"), images };
}

/** A valid `size`×`size` RGB PNG of noise from `seed`: incompressible, so its base64 runs about 4·size² bytes. */
function noisePng(seed: number, size: number): string {
	const stride = 1 + size * 3;
	const raw = new Uint8Array(stride * size);
	let state = seed * 0x9e3779b1 || 1;
	for (let row = 0; row < size; row++) {
		// Each row's filter byte stays 0 (none).
		for (let at = row * stride + 1; at < (row + 1) * stride; at++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			raw[at] = state & 0xff;
		}
	}
	const chunk = (type: string, data: Uint8Array): Buffer => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const out = Buffer.alloc(4 + body.length + 4);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, 4 + body.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // truecolor RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	]).toString("base64");
}

function preservedArchive(preserveData: Record<string, unknown> | undefined): snapcompact.Archive {
	const archive = snapcompact.getPreservedArchive(preserveData);
	if (!archive) throw new Error("Expected a snapcompact archive");
	return archive;
}

function latestCompaction(sessionManager: SessionManager): CompactionEntry {
	const entry = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
	if (entry?.type !== "compaction") throw new Error("Expected a compaction entry");
	return entry;
}

describe("snapcompact archive read by a Claude model", () => {
	const originalAgentDir = getAgentDir();
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-snapcompact-reader-"));
		setAgentDir(path.join(tempDir, "agent"));
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
	});

	afterAll(async () => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Appends an archive rendered under GPT (reasoning included) and a kept reply. */
	async function seedArchive(sessionManager: SessionManager): Promise<snapcompact.CompactionResult> {
		const keptId = sessionManager.appendMessage({ role: "user", content: "Kept turn.", timestamp: Date.now() });
		const archive = await snapcompact.compact(
			{
				firstKeptEntryId: keptId,
				messagesToSummarize: archivedTurns(),
				turnPrefixMessages: [],
				tokensBefore: 100_000,
				fileOps: snapcompact.createFileOps(),
			},
			{ model: gpt },
		);
		expect(snapcompact.getPreservedArchive(archive.preserveData)?.frames.length).toBeGreaterThan(0);
		expect(archive.summary).toContain("¶think:");
		sessionManager.appendCompaction(archive.summary, archive.shortSummary, keptId, archive.tokensBefore, {
			details: archive.details,
			preserveData: archive.preserveData,
			method: "snapcompact",
		});
		sessionManager.appendMessage(assistant(gpt, [{ type: "text", text: "Kept reply." }]));
		return archive;
	}

	function startSession(sessionManager: SessionManager, model: Model): { session: AgentSession; mock: MockModel } {
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		return { session, mock };
	}

	/**
	 * The request carries the stored no-reasoning variant (`frames`, or the
	 * entry's own when its payloads are loaded), and the original archive is
	 * untouched. Returns the variant's frame payloads.
	 */
	function expectVariantSent(
		sessionManager: SessionManager,
		original: snapcompact.CompactionResult,
		context: Context | undefined,
		frames?: string[],
	): string[] {
		const { text, images } = requestContent(context?.messages);
		expect(text).toContain("HISTORY");
		expect(text).toContain(PLAIN_LEGEND);
		expect(text).not.toContain("¶think:");
		expect(text).not.toContain(REASONING);
		const entry = latestCompaction(sessionManager);
		const variant = preservedArchive(entry.preserveData).withoutThinking;
		if (!variant) throw new Error("Expected the archive's no-reasoning variant");
		expect(variant.summary).not.toContain("¶think:");
		expect(snapcompact.archiveSourceText(variant.archive)).not.toContain(REASONING);
		expect(images.length).toBeGreaterThan(0);
		expect(images).toEqual(frames ?? variant.archive.frames.map(frame => frame.data));
		expectOriginalIntact(entry, original);
		return images;
	}

	function expectOriginalIntact(entry: CompactionEntry, original: snapcompact.CompactionResult): void {
		const stored = preservedArchive(entry.preserveData);
		const expected = preservedArchive(original.preserveData);
		expect(entry.summary).toBe(original.summary);
		expect({ ...stored, frames: stored.frames.length, withoutThinking: undefined }).toEqual({
			...expected,
			frames: expected.frames.length,
			withoutThinking: undefined,
		});
		stored.frames.forEach((frame, index) => {
			if (!frame.data.startsWith("blob:sha256:")) expect(frame.data).toBe(expected.frames[index]?.data);
		});
	}

	it("sends the no-reasoning variant after a switch to Claude, and the original after a switch back", async () => {
		const sessionManager = SessionManager.inMemory();
		const original = await seedArchive(sessionManager);
		const { session, mock } = startSession(sessionManager, gpt);

		await session.setModel(claude);
		await session.prompt("Continue.");
		expectVariantSent(sessionManager, original, mock.calls[0]?.context);

		await session.setModel(gpt);
		await session.prompt("Continue again.");
		const { text, images } = requestContent(mock.calls[1]?.context.messages);
		expect(text).toContain("¶think:");
		expect(text).toContain(REASONING);
		expect(images).toEqual(preservedArchive(original.preserveData).frames.map(frame => frame.data));
	});

	it("sends the no-reasoning variant on resume under Claude, persisted beside the original", async () => {
		const cwd = path.join(tempDir, "resume");
		const sessionDir = path.join(cwd, "sessions");
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const original = await seedArchive(sessionManager);
		const { session, mock } = startSession(sessionManager, claude);

		await session.prompt("Continue.");
		const variantFrames = expectVariantSent(sessionManager, original, mock.calls[0]?.context);

		// Both archives' frames persist as blob references, and a resume reads
		// the stored variant without rendering it again.
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const persisted = (await Bun.file(sessionFile).text())
			.split("\n")
			.filter(Boolean)
			.map((line): unknown => JSON.parse(line))
			.find(entry => isRecord(entry) && entry.type === "compaction");
		const stored = preservedArchive(
			isRecord(persisted) && isRecord(persisted.preserveData) ? persisted.preserveData : undefined,
		);
		const storedVariant = stored.withoutThinking;
		if (!storedVariant) throw new Error("Expected the persisted no-reasoning variant");
		const refs = [...stored.frames, ...storedVariant.archive.frames].map(frame => frame.data);
		expect(refs.length).toBeGreaterThan(stored.frames.length);
		expect(refs.every(data => data.startsWith("blob:sha256:"))).toBe(true);

		const resumedManager = await SessionManager.open(sessionFile, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const render = vi.spyOn(snapcompact, "compact");
		const resumed = startSession(resumedManager, claude);
		await resumed.session.prompt("Continue.");
		expect(render).not.toHaveBeenCalled();
		expectVariantSent(resumedManager, original, resumed.mock.calls[0]?.context, variantFrames);
	});

	it("leaves out reasoning an older planner's truncation kept without its label, after a reload", async () => {
		// Written by the planner before cuts restated their scope (one frame, under a
		// reasoning model): the cut dropped a `¶think:` label and kept the reasoning after it.
		const fixture: unknown = await Bun.file(
			path.join(import.meta.dir, "fixtures", "legacy-truncated-snapcompact-archive.json"),
		).json();
		if (!isRecord(fixture) || typeof fixture.summary !== "string" || !isRecord(fixture.preserveData)) {
			throw new Error("Expected a persisted snapcompact compaction");
		}
		const legacyText = preservedArchive(fixture.preserveData).text ?? "";
		expect(legacyText).toContain(REASONING);
		expect(legacyText).not.toContain("¶think:");
		const cwd = path.join(tempDir, "legacy");
		const sessionDir = path.join(cwd, "sessions");
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const keptId = sessionManager.appendMessage({ role: "user", content: "Kept turn.", timestamp: Date.now() });
		sessionManager.appendCompaction(fixture.summary, undefined, keptId, 10_000, {
			preserveData: fixture.preserveData,
			method: "snapcompact",
		});
		sessionManager.appendMessage(assistant(gpt, [{ type: "text", text: "Kept reply." }]));
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");

		const resumedManager = await SessionManager.open(sessionFile, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const { session, mock } = startSession(resumedManager, claude);
		await session.prompt("Continue.");

		const { text } = requestContent(mock.calls[0]?.context.messages);
		expect(text).toContain("Plan the migration.");
		expect(text).toContain("SHORT_ANSWER");
		expect(text).not.toContain(REASONING);
	});

	it("gives a side request to Claude the no-reasoning view while GPT stays active", async () => {
		const sessionManager = SessionManager.inMemory();
		const original = await seedArchive(sessionManager);
		const { session } = startSession(sessionManager, gpt);
		const messages = session.messages;

		const forClaude = requestContent(await session.convertMessagesToLlm(messages, undefined, claude));
		expect(forClaude.text).toContain(PLAIN_LEGEND);
		expect(forClaude.text).not.toContain("¶think:");
		expect(forClaude.text).not.toContain(REASONING);
		// A copy: the caller's array and the live context keep the original.
		expect(session.messages).toBe(messages);
		expect(requestContent(await session.convertMessagesToLlm(messages)).text).toContain(REASONING);
		expectOriginalIntact(latestCompaction(sessionManager), original);
	});

	it("gives repeated side requests to Claude one reasoning-free copy of a summary with no archive", async () => {
		// A summarizer can fold archive text, reasoning legend included, into a plain summary.
		const sessionManager = SessionManager.inMemory();
		const keptId = sessionManager.appendMessage({ role: "user", content: "Kept turn.", timestamp: Date.now() });
		sessionManager.appendCompaction(
			`- \`¶user:\`, \`¶think:\`, \`¶ai:\`, \`¶call:\`: user, assistant reasoning, assistant reply, tool call.\nHISTORY\n¶think: ${REASONING}\n¶ai: done`,
			undefined,
			keptId,
			50_000,
		);
		const { session } = startSession(sessionManager, gpt);
		const messages = session.messages;
		const summaryOf = (converted: Message[]) =>
			converted.find(message => message.role === "user" && JSON.stringify(message.content).includes("HISTORY"));

		const first = summaryOf(await session.convertMessagesToLlm(messages, undefined, claude));
		const second = summaryOf(await session.convertMessagesToLlm(messages, undefined, claude));

		expect(JSON.stringify(first)).not.toContain(REASONING);
		expect(JSON.stringify(first)).toContain(PLAIN_LEGEND);
		// One identity, so conversion caches and the date/cwd reminder root hold across requests.
		expect(second).toBe(first);
	});

	it("sends text without reasoning and no frames when the variant cannot be rendered", async () => {
		const sessionManager = SessionManager.inMemory();
		const original = await seedArchive(sessionManager);
		const { session, mock } = startSession(sessionManager, gpt);
		vi.spyOn(snapcompact, "compact").mockRejectedValue(new Error("renderer unavailable"));

		await session.setModel(claude);
		await session.prompt("Continue.");

		const { text, images } = requestContent(mock.calls[0]?.context.messages);
		expect(text).toContain("HISTORY");
		expect(text).toContain(PLAIN_LEGEND);
		expect(text).not.toContain("¶think:");
		expect(text).not.toContain(REASONING);
		expect(text).toContain("reply 39");
		expect(images).toEqual([]);
		const entry = latestCompaction(sessionManager);
		expect(snapcompact.getPreservedArchive(entry.preserveData)?.withoutThinking).toBeUndefined();
		expectOriginalIntact(entry, original);
	});

	/**
	 * Appends a GPT archive whose stored no-reasoning variant carries `count`
	 * distinct ~1 MB frames. Returns the variant's frame payloads, oldest first.
	 */
	function seedLargeVariant(sessionManager: SessionManager, count: number): string[] {
		const frame = (seed: number, size: number) => ({
			data: noisePng(seed, size),
			mimeType: "image/png",
			cols: 4,
			rows: 2,
			chars: 8,
		});
		const variantFrames = Array.from({ length: count }, (_, index) => frame(index + 1, 512));
		const keptId = sessionManager.appendMessage({ role: "user", content: "Kept turn.", timestamp: Date.now() });
		sessionManager.appendCompaction(
			`- \`¶user:\`, \`¶think:\`, \`¶ai:\`, \`¶call:\`: user, assistant reasoning, assistant reply, tool call.\nHISTORY`,
			undefined,
			keptId,
			100_000,
			{
				method: "snapcompact",
				preserveData: {
					[snapcompact.PRESERVE_KEY]: {
						frames: [frame(1_000, 16)],
						totalChars: 100,
						truncatedChars: 0,
						textHead: `¶user: ask\n¶think: ${REASONING}\n`,
						textTail: "¶ai: answer",
						withoutThinking: {
							summary: `- ${PLAIN_LEGEND}\nHISTORY`,
							archive: {
								frames: variantFrames,
								totalChars: 100,
								truncatedChars: 0,
								textHead: "¶user: ask\n",
								textTail: "¶ai: answer",
							},
						},
					},
				},
			},
		);
		sessionManager.appendMessage(assistant(gpt, [{ type: "text", text: "Kept reply." }]));
		return variantFrames.map(entry => entry.data);
	}

	it("reads the no-reasoning view at each reader's own frame budget on switch, side conversion and resume", async () => {
		const official = claude;
		const proxy = buildModel({ ...toModelSpec(claude), baseUrl: "https://anthropic-proxy.example.com" });
		const proxyBudget = snapcompact.frameDataBytesBudget(proxy);
		expect(snapcompact.frameDataBytesBudget(official)).toBe(12_000_000);
		expect(proxyBudget).toBe(snapcompact.DEFAULT_FRAME_DATA_BYTES_BUDGET);
		const cwd = path.join(tempDir, "frame-budget");
		const sessionDir = path.join(cwd, "sessions");
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const frames = seedLargeVariant(sessionManager, 8);
		const variantBytes = frames.reduce((bytes, data) => bytes + data.length, 0);
		expect(variantBytes).toBeGreaterThan(proxyBudget);
		expect(variantBytes).toBeLessThan(12_000_000);
		expect(new Set(frames).size).toBe(frames.length);
		// The newest frames that fit the proxy's budget.
		const proxyFrames: string[] = [];
		let proxyBytes = 0;
		for (const data of frames.toReversed()) {
			if (proxyBytes + data.length > proxyBudget) continue;
			proxyBytes += data.length;
			proxyFrames.unshift(data);
		}
		expect(proxyFrames.length).toBeLessThan(frames.length);
		const summaryOf = (messages: readonly Message[] | undefined) =>
			messages?.find(message => message.role === "user" && JSON.stringify(message.content).includes("HISTORY"));
		const { session, mock } = startSession(sessionManager, gpt);

		// A switch to official Claude sends every frame of the view.
		await session.setModel(official);
		await session.prompt("Continue.");
		const switched = requestContent(mock.calls[0]?.context.messages);
		expect(switched.images).toEqual(frames);
		expect(switched.text).toContain(PLAIN_LEGEND);
		expect(switched.text).not.toContain(REASONING);

		// Side conversion: the proxy reader gets the frames its budget holds, and
		// repeated official conversions keep one summary message and its bytes.
		const messages = session.messages;
		const forProxy = requestContent(await session.convertMessagesToLlm(messages, undefined, proxy));
		expect(forProxy.images).toEqual(proxyFrames);
		expect(forProxy.text).not.toContain(REASONING);
		const first = summaryOf(await session.convertMessagesToLlm(messages, undefined, official));
		const second = summaryOf(await session.convertMessagesToLlm(messages, undefined, official));
		expect(second).toBe(first);
		expect(requestContent(first ? [first] : []).images).toEqual(frames);

		// A live switch to the proxy caps the frames; switching back regains them
		// under the summary message official Claude was sent before.
		await session.setModel(proxy);
		await session.prompt("Through the proxy.");
		expect(requestContent(mock.calls[1]?.context.messages).images).toEqual(proxyFrames);
		await session.setModel(official);
		await session.prompt("Back on the official API.");
		const regained = mock.calls[2]?.context.messages;
		expect(requestContent(regained).images).toEqual(frames);
		expect(summaryOf(regained)).toBe(summaryOf(mock.calls[0]?.context.messages));
		expect(requestContent(regained).text).not.toContain(REASONING);

		// A resume under official Claude reads every frame from the persisted blobs.
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const resumedManager = await SessionManager.open(sessionFile, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const resumed = startSession(resumedManager, official);
		await resumed.session.prompt("Continue.");
		const afterResume = requestContent(resumed.mock.calls[0]?.context.messages);
		expect(afterResume.images).toEqual(frames);
		expect(afterResume.text).not.toContain(REASONING);
	});

	it("checks only messages appended since the previous model call of a tool loop", async () => {
		const sessionManager = SessionManager.inMemory();
		const original = await seedArchive(sessionManager);
		const { session, mock } = startSession(sessionManager, claude);
		const summaryChecks = vi.spyOn(snapcompact, "summaryIncludesThinking");
		const checksAtCall: number[] = [];
		for (let call = 0; call < 4; call++) {
			mock.push(() => {
				checksAtCall.push(summaryChecks.mock.calls.length);
				return call < 3
					? { content: [{ type: "toolCall", name: "missing_tool", arguments: {} }] }
					: { content: ["done"] };
			});
		}

		await session.prompt("Continue.");

		expect(checksAtCall).toHaveLength(4);
		// The swap replaces the agent's message list once, which the next call
		// checks in full; after that only the appended tool turns are visited.
		expect(checksAtCall[3]).toBe(checksAtCall[2]);
		expectVariantSent(sessionManager, original, mock.calls[3]?.context);
	});
});
