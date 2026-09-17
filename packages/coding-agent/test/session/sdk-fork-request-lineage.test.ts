/**
 * End-to-end SDK fork lineage: a real createAgentSession on a real
 * openai-codex-responses model, with only the outbound fetch mocked.
 *
 * - A root session must never self-fork: turn two carries no parent-thread
 *   header and no replayed native prefix, even after its own request was
 *   captured by the snapshot callback.
 * - A child seeded with the parent's produced snapshot keeps the SAME parent
 *   lineage on every turn (session-id + parent-thread headers), never
 *   substituting its own produced request for the origin.
 * - A reset_boundary (/clear) retires the origin: the next request projects
 *   the child's own session identity again.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type ForkRequestSnapshot,
	FORK_REQUEST_CONTEXT_TYPE,
	recordForkRequestSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/fork-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const CODEX_MODEL = getBundledModel("openai-codex", "gpt-5.6-sol");

/** The task tool's built-in agent definition, enough for discovery resolution. */
const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

/** Fake ChatGPT access token carrying `chatgpt_account_id` for the account guard. */
function fakeAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `${header}.${payload}.sig`;
}

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function codexSse(text: string, responseId: string): Response {
	// Full happy-path event sequence: the provider tracks open items between
	// output_item.added and output_item.done, so omitting `added` turns every
	// reply into an empty assistant stop.
	const body = `${[
		`data: ${JSON.stringify({ type: "response.created", response: { id: responseId } })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "in_progress",
				content: [],
			},
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	].join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface SessionHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
}

/** Fetch override installed for the harness lifetime; the caller restores it. */
function installFetchCapture(captured: CapturedRequest[]): void {
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const initHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const rawBody =
				typeof init?.body === "string"
					? new TextEncoder().encode(init.body)
					: init?.body instanceof ArrayBuffer
						? new Uint8Array(init.body)
						: init?.body instanceof Uint8Array
							? init.body
							: undefined;
			if (!url.includes("/responses") || rawBody === undefined) {
				// Anything else the session reaches for gets a harmless empty 200 —
				// the assertion set only consumes captured /responses bodies.
				return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
			}
			// Codex request bodies arrive zstd-compressed.
			const plain = initHeaders.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(rawBody) : rawBody;
			const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
			if (!isRecord(parsed)) throw new Error("expected a JSON object request body");
			captured.push({
				url,
				headers: Object.fromEntries(initHeaders.entries()),
				body: parsed,
			});
			return codexSse(`reply-${captured.length}`, `resp_${captured.length}`);
		},
		{ preconnect: async () => {} },
	);
}

async function createHarness(
	tempDir: TempDir,
	options: {
		cwd: string;
		sessionManager: SessionManager;
		forkRequest?: ForkRequestSnapshot;
		accountId: string;
	},
): Promise<SessionHarness> {
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${crypto.randomUUID()}.db`));
	authStorage.setRuntimeApiKey("openai-codex", fakeAccessToken(options.accountId));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join(`models-${crypto.randomUUID()}.yml`));
	const result = await createAgentSession({
		cwd: options.cwd,
		agentDir: tempDir.path(),
		authStorage,
		modelRegistry,
		model: CODEX_MODEL,
		sessionManager: options.sessionManager,
		forkRequest: options.forkRequest,
		settings: Settings.isolated({ "async.enabled": false, "marketplace.autoUpdate": "off" }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	return {
		session: result.session,
		sessionManager: options.sessionManager,
		authStorage,
	};
}

function header(request: CapturedRequest, name: string): string | undefined {
	const match = Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return match?.[1];
}

function bodyContains(request: CapturedRequest, marker: string): number {
	return JSON.stringify(request.body.input).split(marker).length - 1;
}

function expectDefined<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`expected ${what} to be defined`);
	return value;
}

describe("sdk fork request lineage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("never self-forks a root session and keeps parent lineage in a forked child until /clear", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const capturedSpawn: Array<{ fork: Parameters<typeof executorModule.runSubprocess>[0]["fork"] }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedSpawn.push({ fork: options.fork });
			return {
				index: 0,
				id: options.id ?? "child",
				agent: "task",
				agentSource: "bundled",
				task: "probe",
				assignment: "probe",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
			} satisfies SingleResult;
		});

		using tempDir = TempDir.createSync("@omp-sdk-fork-lineage-");
		const cwd = tempDir.join("project");
		await Bun.$`mkdir -p ${cwd}`.quiet();
		const realFetch = globalThis.fetch;
		const requests: CapturedRequest[] = [];
		installFetchCapture(requests);
		const parent = await createHarness(tempDir, {
			cwd,
			sessionManager: SessionManager.inMemory(cwd),
			accountId: "acct-parent",
		});
		let child: SessionHarness | undefined;
		const requestsWith = (marker: string): CapturedRequest[] =>
			requests.filter(request => JSON.stringify(request.body.input).includes(marker));
		try {
			// Two real parent turns against the real codex provider path.
			const lastAssistantText = (session: AgentSession): string =>
				session.agent.state.messages
					.filter(message => message.role === "assistant")
					.flatMap(message =>
						message.content.filter((block): block is { type: "text"; text: string } => block.type === "text"),
					)
					.map(block => block.text)
					.join("\n");
			await parent.session.prompt("remember MARKER-ALPHA");
			await parent.session.waitForIdle();
			// The mock returns real text; an empty reply would trip the
			// empty-stop retry path and pollute every later request body.
			expect(lastAssistantText(parent.session)).toContain("reply-");
			await parent.session.prompt("second turn MARKER-BETA");
			await parent.session.waitForIdle();
			expect(lastAssistantText(parent.session)).toContain("reply-");
			const parentTurns = requestsWith("MARKER-BETA");
			const parentTurn2 = parentTurns[0];
			expect(parentTurn2).toBeDefined();
			const firstRequest = requests[0];
			expect(firstRequest).toBeDefined();

			const parentSessionHeader = header(expectDefined(firstRequest, "first parent request"), "session-id");
			const parentThreadHeader = header(expectDefined(firstRequest, "first parent request"), "thread-id");
			expect(parentSessionHeader).toBeDefined();
			expect(parentThreadHeader).toBeDefined();
			// A root session never carries fork lineage — even on turn 2, after
			// its own request was captured by onCodexRequestSnapshot.
			expect(header(expectDefined(parentTurn2, "parent turn 2"), "x-codex-parent-thread-id")).toBeUndefined();
			expect(header(expectDefined(parentTurn2, "parent turn 2"), "session-id")).toBe(parentSessionHeader);
			// Turn 2 must not replay turn 1's serialized input ahead of its own:
			// a self-fork duplicates the leading turn verbatim.
			expect(bodyContains(expectDefined(parentTurn2, "parent turn 2"), "MARKER-ALPHA")).toBe(1);

			// The produced request the next fork: "all" child would inherit,
			// obtained through the task tool's public execute boundary.
			const taskTool = parent.session.getToolByName("task");
			expect(taskTool).toBeDefined();
			const spawnResult = await expectDefined(taskTool, "task tool").execute("tc-fork-spawn", {
				agent: "task",
				name: "ForkedChild",
				task: "probe the fork",
				fork: "all",
			});
			expect(spawnResult).toBeDefined();
			expect(capturedSpawn.length).toBe(1);
			const forkRequest = capturedSpawn[0]?.fork?.request;
			const forkMessages = capturedSpawn[0]?.fork?.messages ?? [];
			expect(forkRequest?.request.sessionId).toBeDefined();
			expect(forkMessages.length).toBeGreaterThan(0);

			// Real child on a seeded journal: the same state the executor writes
			// before createAgentSession.
			const childManager = SessionManager.inMemory(cwd);
			for (const message of forkMessages) {
				childManager.appendMessage(message, { inherited: true });
			}
			recordForkRequestSnapshot(childManager, expectDefined(forkRequest, "fork request"));
			child = await createHarness(tempDir, {
				cwd,
				sessionManager: childManager,
				forkRequest,
				accountId: "acct-parent",
			});

			await child.session.prompt("first child turn MARKER-GAMMA");
			await child.session.waitForIdle();
			await child.session.prompt("second child turn MARKER-DELTA");
			await child.session.waitForIdle();
			const childTurn1 = requestsWith("MARKER-GAMMA")[0];
			const childTurn2 = requestsWith("MARKER-DELTA")[0];
			expect(childTurn1).toBeDefined();
			expect(childTurn2).toBeDefined();

			// Both child turns project the SAME parent lineage — the origin is
			// the parent's request, never the child's own produced request.
			expect(header(expectDefined(childTurn1, "child turn 1"), "session-id")).toBe(parentSessionHeader);
			expect(header(expectDefined(childTurn1, "child turn 1"), "x-codex-parent-thread-id")).toBe(parentThreadHeader);
			expect(header(expectDefined(childTurn2, "child turn 2"), "session-id")).toBe(parentSessionHeader);
			expect(header(expectDefined(childTurn2, "child turn 2"), "x-codex-parent-thread-id")).toBe(parentThreadHeader);
			// Child keeps its own distinct thread identity.
			const childThread = header(expectDefined(childTurn1, "child turn 1"), "thread-id");
			expect(childThread).toBeDefined();
			expect(childThread).not.toBe(parentThreadHeader);
			expect(header(expectDefined(childTurn2, "child turn 2"), "thread-id")).toBe(childThread);
			// The parent's wire prefix is replayed once — never re-duplicated by
			// a self-reference on the child's second turn.
			expect(bodyContains(expectDefined(childTurn1, "child turn 1"), "MARKER-ALPHA")).toBe(1);
			expect(bodyContains(expectDefined(childTurn2, "child turn 2"), "MARKER-ALPHA")).toBe(1);

			// Cache-relevant property, wire-level: both child turns start with the
			// parent's turn-2 input verbatim, item for item — followed only by the
			// child's own leading `additional_tools` surface and its new tail.
			const parentPrefix = expectDefined(parentTurn2, "parent turn 2").body.input;
			expect(Array.isArray(parentPrefix)).toBe(true);
			if (!Array.isArray(parentPrefix)) throw new Error("expected parent turn 2 input to be an array");
			const prefixLen = parentPrefix.length;
			const assertPrefix = (request: CapturedRequest, label: string): void => {
				const input = request.body.input;
				expect(Array.isArray(input), label).toBe(true);
				if (!Array.isArray(input)) throw new Error(`expected ${label} input to be an array`);
				const items = input;
				expect(items.length, `${label} length`).toBeGreaterThan(prefixLen);
				expect(items.slice(0, prefixLen), `${label} leading slice`).toEqual(parentPrefix);
				const follower = items[prefixLen];
				expect(
					isRecord(follower) && follower.type === "additional_tools",
					`${label} first non-prefix item is the child's additional_tools surface`,
				).toBe(true);
			};
			assertPrefix(expectDefined(childTurn1, "child turn 1"), "child turn 1");
			assertPrefix(expectDefined(childTurn2, "child turn 2"), "child turn 2");

			// /clear retires the origin: the next request is the child's own.
			await child.session.resetSessionContext();
			await child.session.prompt("after clear");
			await child.session.waitForIdle();
			const afterClear = requestsWith("after clear")[0];
			expect(afterClear).toBeDefined();
			expect(header(expectDefined(afterClear, "post-clear request"), "session-id")).not.toBe(parentSessionHeader);
			expect(header(expectDefined(afterClear, "post-clear request"), "x-codex-parent-thread-id")).toBeUndefined();
			expect(bodyContains(expectDefined(afterClear, "post-clear request"), "MARKER-ALPHA")).toBe(0);
		} finally {
			globalThis.fetch = realFetch;
			await parent.session.dispose();
			parent.authStorage.close();
			if (child !== undefined) {
				await child.session.dispose();
				child.authStorage.close();
			}
		}
	}, 60_000);

	it("a malformed journal marker blocks options.forkRequest re-seeding at construction", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-fork-badmarker-");
		const cwd = tempDir.join("project");
		await Bun.$`mkdir -p ${cwd}`.quiet();
		const manager = SessionManager.inMemory(cwd);
		// A malformed marker occupies the origin slot: createAgentSession must
		// not append a second marker from the caller's stale forkRequest.
		manager.appendCustomEntry(FORK_REQUEST_CONTEXT_TYPE, { request: { provider: 42 } });
		const markersBefore = manager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === FORK_REQUEST_CONTEXT_TYPE).length;

		let harness: SessionHarness | undefined;
		try {
			harness = await createHarness(tempDir, {
				cwd,
				sessionManager: manager,
				forkRequest: {
					request: {
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						baseUrl: "https://chatgpt.com/backend-api/codex",
						accountId: "acct-parent",
						sessionId: "sess-parent",
						threadId: "thread-parent",
						input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "seed" }] }],
					},
					messageFingerprints: [],
				},
				accountId: "acct-parent",
			});
			const markers = manager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === FORK_REQUEST_CONTEXT_TYPE);
			expect(markers).toHaveLength(markersBefore);
		} finally {
			if (harness !== undefined) {
				await harness.session.dispose();
				harness.authStorage.close();
			}
		}
	});
});
