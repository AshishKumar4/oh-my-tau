import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthGatewayServerHandle, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { recordHarnessRequest } from "@oh-my-pi/pi-coding-agent/harness/record";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { withHarnessCacheDir } from "./helpers/harness";

const GEMINI = getBundledModel<"google-generative-ai">("google", "gemini-4-carbon");
const GEMINI_CLI_VERSION = "0.18.4";
const GEMINI_HEADERS: Record<string, string> = {
	"content-type": "application/json",
	"x-goog-api-key": "omp-harness-recording",
	"user-agent": `GeminiCLI/${GEMINI_CLI_VERSION} (linux; x64)`,
	"x-goog-api-client": "google-genai-sdk/1.30.0 gl-node/v25.2.1",
};

// Synthetic stand-ins for Gemini CLI's surface: its real prompt and tool text are never vendored.
const SYSTEM_INSTRUCTION = "You are a synthetic command-line agent.\n\n# Rules\n\nUse read_file before replace.";
const READ_FILE_SCHEMA = {
	type: "object",
	properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
	required: ["file_path"],
};
const DECLARATIONS = [
	{ name: "read_file", description: "Synthetic read.", parametersJsonSchema: READ_FILE_SCHEMA },
	{
		name: "run_shell_command",
		description: "Synthetic shell.",
		parametersJsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
	{
		name: "list_directory",
		description: "Synthetic listing.",
		parametersJsonSchema: { type: "object", properties: { dir_path: { type: "string" } }, required: ["dir_path"] },
	},
	{
		name: "codebase_investigator",
		description: "Synthetic subagent.",
		parametersJsonSchema: { type: "object", properties: { objective: { type: "string" } } },
	},
];

function geminiCliBody(declarations: readonly unknown[] = DECLARATIONS): Record<string, unknown> {
	return {
		contents: [
			{ role: "user", parts: [{ text: "This is the Gemini CLI. We are setting up the context for our chat." }] },
			{ role: "user", parts: [{ text: "hi" }] },
		],
		systemInstruction: { role: "user", parts: [{ text: SYSTEM_INSTRUCTION }] },
		tools: declarations.length === 0 ? [] : [{ functionDeclarations: declarations }],
		generationConfig: { temperature: 1 },
	};
}

/** One streamed Gemini turn: model parts, then STOP. */
function geminiTurn(parts: readonly Record<string, unknown>[]): Response {
	const chunk = {
		candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } });
}

interface GeminiRequest {
	systemInstruction?: { parts?: { text?: string }[] };
	tools?: { functionDeclarations?: { name: string; parametersJsonSchema?: unknown; parameters?: unknown }[] }[];
	contents?: { role: string; parts: Record<string, unknown>[] }[];
}

function declaredNames(request: GeminiRequest): string[] {
	return (request.tools ?? []).flatMap(tool => (tool.functionDeclarations ?? []).map(declaration => declaration.name));
}

describe("gemini-cli harness", () => {
	const dirs = withHarnessCacheDir("omp-harness-gemini-cli-");
	const gateways: { handle: AuthGatewayServerHandle; storage: AuthStorage }[] = [];
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `omp-harness-gemini-cli-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("google", "google-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const gateway of gateways) {
			await gateway.handle.close();
			gateway.storage.close();
		}
		gateways.length = 0;
	});

	/** A gateway whose upstream transport fails the test if anything tries to leave the process. */
	async function bootGateway(record: boolean): Promise<{ url: string; upstream: Mock<() => Promise<Response>> }> {
		const storage = await AuthStorage.create(path.join(dirs.root, `gateway-${gateways.length}.db`));
		const upstream = vi.fn(async () => new Response("recording must not reach a provider", { status: 599 }));
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			storage,
			version: "test",
			resolveModel: () => undefined,
			fetch: upstream,
			...(record && { harnessRecorder: recordHarnessRequest }),
		});
		gateways.push({ handle, storage });
		return { url: handle.url, upstream };
	}

	async function captureFiles(): Promise<string[]> {
		try {
			return (await fs.readdir(path.join(dirs.cache, "gemini-cli"))).sort();
		} catch {
			return [];
		}
	}

	async function recordGeminiCliTurn(): Promise<void> {
		const gateway = await bootGateway(true);
		const response = await fetch(`${gateway.url}/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers: GEMINI_HEADERS,
			body: JSON.stringify(geminiCliBody()),
		});
		expect(response.status).toBe(200);
		await response.text();
	}

	async function openSession(settings: Settings) {
		const workDir = path.join(tempDir, `work-${Snowflake.next()}`);
		await fs.mkdir(workDir, { recursive: true });
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir: workDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: GEMINI,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: workDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		return { session, workDir };
	}

	/** Answers every Gemini request at the fetch seam with the next scripted turn, recording the bodies. */
	function scriptGemini(turns: readonly Record<string, unknown>[][]): GeminiRequest[] {
		const requests: GeminiRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (!url.startsWith("https://generativelanguage.googleapis.com/")) {
					throw new Error(`unexpected request to ${url}`);
				}
				const body: unknown = JSON.parse(String(init?.body));
				if (!isRecord(body)) throw new Error("Gemini request body is not an object");
				requests.push(body);
				return geminiTurn(turns[requests.length - 1] ?? [{ text: "done" }]);
			}),
		);
		return requests;
	}

	it("records a Gemini CLI turn through the Gemini route, answers it locally, and forwards nothing", async () => {
		const gateway = await bootGateway(true);
		const post = (method: string, body: Record<string, unknown>, headers = GEMINI_HEADERS) =>
			fetch(`${gateway.url}/v1beta/models/gemini-2.5-pro:${method}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

		// Side requests answer locally and write nothing: one declares no functions,
		// one names Node's version where Gemini CLI's belongs.
		expect((await post("generateContent", geminiCliBody([]))).status).toBe(200);
		const nodeVersion = await post("streamGenerateContent?alt=sse", geminiCliBody(), {
			...GEMINI_HEADERS,
			"user-agent": "GeminiCLI/v25.2.1 (linux; x64)",
		});
		expect(nodeVersion.status).toBe(200);
		await nodeVersion.text();
		expect(await captureFiles()).toEqual([]);

		const response = await post("streamGenerateContent?alt=sse", geminiCliBody());
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const frame = (await response.text()).trim();
		expect(frame.startsWith("data: ")).toBe(true);
		const turn: unknown = JSON.parse(frame.slice("data: ".length));
		expect(turn).toMatchObject({ candidates: [{ finishReason: "STOP", content: { role: "model" } }] });

		expect(gateway.upstream).not.toHaveBeenCalled();
		expect(await captureFiles()).toEqual([`${GEMINI_CLI_VERSION}-GeminiCLI.json`]);
		const capture: unknown = await Bun.file(
			path.join(dirs.cache, "gemini-cli", `${GEMINI_CLI_VERSION}-GeminiCLI.json`),
		).json();
		expect(capture).toMatchObject({
			profile: "gemini-cli",
			clientVersion: GEMINI_CLI_VERSION,
			entrypoint: "GeminiCLI",
			instructions: [SYSTEM_INSTRUCTION],
			tools: DECLARATIONS.map(declaration => declaration.name),
		});

		// Without --record-harness the Gemini route does not exist.
		const plain = await bootGateway(false);
		const refused = await fetch(`${plain.url}/v1beta/models/gemini-2.5-pro:generateContent`, {
			method: "POST",
			headers: GEMINI_HEADERS,
			body: JSON.stringify(geminiCliBody()),
		});
		expect(refused.status).toBe(404);
		expect(plain.upstream).not.toHaveBeenCalled();
	});

	it("serves a recorded capture on a google request and bridges a vendor tool call back to omp", async () => {
		await recordGeminiCliTurn();
		const { session, workDir } = await openSession(Settings.isolated({}));
		const file = path.join(workDir, "notes.txt");
		await Bun.write(file, "line one\nline two\nline three\n");
		// The model reads one line with Gemini CLI's 0-based offset, then stops.
		const requests = scriptGemini([
			[{ functionCall: { name: "read_file", args: { file_path: file, offset: 1, limit: 1 } } }],
			[{ text: "done" }],
		]);
		try {
			await session.prompt("read the second line");
		} finally {
			await session.dispose();
		}

		expect(requests.length).toBe(2);
		const [first, second] = requests;
		expect(first.systemInstruction?.parts?.[0]?.text).toBe(SYSTEM_INSTRUCTION);
		const names = declaredNames(first);
		expect(names).toEqual(
			expect.arrayContaining(["read_file", "run_shell_command", "write_file", "replace", "list_directory"]),
		);
		expect(names).not.toContain("read");
		expect(names).not.toContain("bash");
		// Gemini CLI's subagent has no omp counterpart, so it is not offered.
		expect(names).not.toContain("codebase_investigator");
		const readFile = first.tools
			?.flatMap(tool => tool.functionDeclarations ?? [])
			.find(declaration => declaration.name === "read_file");
		expect(readFile?.parametersJsonSchema ?? readFile?.parameters).toMatchObject(READ_FILE_SCHEMA);

		// The call came back as omp's read over the 0-based window, answered under the vendor name.
		const response = second.contents
			?.flatMap(content => content.parts)
			.find(part => isRecord(part.functionResponse))?.functionResponse;
		expect(response).toMatchObject({ name: "read_file" });
		const text = JSON.stringify(response);
		expect(text).toContain("line two");
		expect(text).not.toContain("line one");
		expect(text).not.toContain("line three");
	});

	it("keeps a Gemini model native without a capture unless the profile is forced", async () => {
		const auto = await openSession(Settings.isolated({}));
		const autoRequests = scriptGemini([[{ text: "done" }]]);
		try {
			await auto.session.prompt("hi");
		} finally {
			await auto.session.dispose();
		}
		const autoNames = declaredNames(autoRequests[0]);
		expect(autoNames).toEqual(expect.arrayContaining(["read", "bash"]));
		expect(autoNames).not.toContain("read_file");

		vi.restoreAllMocks();
		const forced = await openSession(Settings.isolated({ "harness.mode": "gemini-cli" }));
		const forcedRequests = scriptGemini([[{ text: "done" }]]);
		try {
			await forced.session.prompt("hi");
		} finally {
			await forced.session.dispose();
		}
		const forcedNames = declaredNames(forcedRequests[0]);
		expect(forcedNames).toEqual(expect.arrayContaining(["read_file", "run_shell_command"]));
		expect(forcedNames).not.toContain("read");
		expect(forcedRequests[0].systemInstruction?.parts?.[0]?.text).not.toBe(SYSTEM_INSTRUCTION);
	});
});
