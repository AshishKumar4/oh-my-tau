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
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
