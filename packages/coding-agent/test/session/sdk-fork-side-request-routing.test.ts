/**
 * A forked child's side request (`runEphemeralTurn`: /btw, IRC relays) must
 * reach the prompt cache its foreground turns warm. The Codex backend derives
 * cache affinity from the session headers, and a forked child's foreground
 * projects its fork root there, so the side request has to send the same
 * routing headers while keeping its own thread and turn identity.
 *
 * End to end: real createAgentSession sessions on a real openai-codex model,
 * with only the outbound fetch mocked.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type ForkRequestSnapshot, recordForkRequestSnapshot } from "@oh-my-pi/pi-coding-agent/session/fork-context";
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
	authStorage.keys.setRuntime("openai-codex", fakeAccessToken(options.accountId));
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

function expectDefined<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`expected ${what} to be defined`);
	return value;
}

describe("sdk fork side-request routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes a forked child's side request like the child's foreground turns", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const capturedSpawn: Array<Parameters<typeof executorModule.runSubprocess>[0]["fork"]> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedSpawn.push(options.fork);
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

		using tempDir = TempDir.createSync("@omp-sdk-fork-side-");
		const cwd = tempDir.join("project");
		await Bun.$`mkdir -p ${cwd}`.quiet();
		const realFetch = globalThis.fetch;
		const requests: CapturedRequest[] = [];
		installFetchCapture(requests);
		const requestWith = (marker: string): CapturedRequest =>
			expectDefined(
				requests.find(request => JSON.stringify(request.body.input).includes(marker)),
				`request carrying ${marker}`,
			);
		const parent = await createHarness(tempDir, {
			cwd,
			sessionManager: SessionManager.inMemory(cwd),
			accountId: "acct-parent",
		});
		let child: SessionHarness | undefined;
		try {
			await parent.session.prompt("root turn MARKER-ROOT");
			await parent.session.waitForIdle();
			const rootTurn = requestWith("MARKER-ROOT");

			const taskTool = expectDefined(parent.session.getToolByName("task"), "task tool");
			await taskTool.execute("tc-fork-spawn", {
				agent: "task",
				name: "ForkedChild",
				task: "probe the fork",
				fork: "all",
			});
			const fork = expectDefined(capturedSpawn[0], "fork spawn");
			const forkRequest = expectDefined(fork.request, "fork request");
			const childManager = SessionManager.inMemory(cwd);
			for (const message of fork.messages ?? []) childManager.appendMessage(message, { inherited: true });
			recordForkRequestSnapshot(childManager, forkRequest);
			child = await createHarness(tempDir, {
				cwd,
				sessionManager: childManager,
				forkRequest,
				accountId: "acct-parent",
			});

			await child.session.prompt("child turn MARKER-CHILD");
			await child.session.waitForIdle();
			await child.session.runEphemeralTurn({ promptText: "side question MARKER-SIDE" });
			const foreground = requestWith("MARKER-CHILD");
			const side = requestWith("MARKER-SIDE");

			// The child's foreground projects the fork root in its session headers.
			expect(header(foreground, "session-id")).toBe(header(rootTurn, "session-id"));
			for (const name of ["session_id", "session-id", "conversation_id"]) {
				expect(header(side, name), name).toBe(header(foreground, name));
			}
			// Its own thread and turn, and the root's cache key the child's turns send.
			expect(header(side, "thread-id")).not.toBe(header(foreground, "thread-id"));
			expect(header(side, "x-client-request-id")).not.toBe(header(foreground, "x-client-request-id"));
			expect(foreground.body.prompt_cache_key).toBe(rootTurn.body.prompt_cache_key);
			expect(side.body.prompt_cache_key).toBe(foreground.body.prompt_cache_key);
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
});
