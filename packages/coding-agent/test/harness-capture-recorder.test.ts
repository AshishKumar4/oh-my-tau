import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { type AuthGatewayServerHandle, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import {
	claudeCodeBillingHeaderPrefix,
	claudeCodeEntrypoint,
	claudeCodeSystemInstruction,
} from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	assertHarnessRecordingConfined,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import {
	HARNESS_CAPTURE_SCHEMA,
	loadHarnessPrompt,
	resetHarnessPromptCache,
} from "@oh-my-pi/pi-coding-agent/harness/capture";
import { recordHarnessRequest } from "@oh-my-pi/pi-coding-agent/harness/record";
import * as brokerConfig from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { withHarnessCacheDir } from "./helpers/harness";

const CLIENT_VERSION = "2.1.267.d7f";
const HARNESS_PROMPT_BLOCK =
	"\nYou are an interactive agent that helps users with software engineering tasks.\n\n# Tone\n\nBe terse. \n\n\n# Tools\n\nUse `Bash` for shell work.";
const SUBAGENT_PROMPT_BLOCK =
	"\nYou are an agent spawned to search a codebase.\n\n# Tone\n\nAnswer with file paths only.";
const AMBIENT_CLAUDE_MD =
	"<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions.\n# CLAUDE.md\n\nDeploy secrets live in vault://prod. Never run terraform apply.\n</system-reminder>";
const AMBIENT_ENVIRONMENT =
	"<system-reminder>\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /tmp/capture-run\n</system-reminder>";

const CODEX_VERSION = "0.154.0";
const CODEX_ENTRYPOINT = "codex_exec";
const CODEX_BASE_PROMPT = "You are Codex, an agent based on GPT-6. You and the user share one workspace.";
const CODEX_MEMORY_BLOCK = "## Memory\n\nYou have access to a memory folder with guidance from prior runs.";
const CODEX_SKILLS_BLOCK =
	"<skills_instructions>\n## Skills\nA skill is a set of local instructions.\n</skills_instructions>";
const CODEX_SANDBOX_BLOCK =
	"# Sandboxing and approvals\n\nThis session is running with approval policy `never` and filesystem sandbox `danger-full-access`.";
const AMBIENT_AGENTS_MD =
	"# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# Global Rules\n\nNever force-push. Deploy keys live in vault://prod.\n</INSTRUCTIONS>";
const AMBIENT_ENVIRONMENT_CONTEXT =
	"<environment_context>\n  <cwd>/tmp/capture-run</cwd>\n  <shell>bash</shell>\n</environment_context>";

const MOCK_REPLY = {
	content: ["ok"],
	usage: { input: 10, output: 5, totalTokens: 15, cost: { input: 0, output: 0, total: 0 } },
};
const AMBIENT_NEEDLE_MIN_CHARS = 64;

function claudeCodeBody(entrypoint: string, stream: boolean): Record<string, unknown> {
	return {
		model: "claude-sonnet-5",
		max_tokens: 32000,
		stream,
		system: [
			{
				type: "text",
				text: `${claudeCodeBillingHeaderPrefix} cc_version=${CLIENT_VERSION}; cc_entrypoint=${entrypoint};`,
			},
			{ type: "text", text: claudeCodeSystemInstruction, cache_control: { type: "ephemeral" } },
			{ type: "text", text: HARNESS_PROMPT_BLOCK, cache_control: { type: "ephemeral" } },
		],
		tools: [
			{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: {} } },
			{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
		],
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: AMBIENT_CLAUDE_MD },
					{ type: "text", text: "hi" },
				],
			},
			{ role: "system", content: [{ type: "text", text: AMBIENT_ENVIRONMENT }] },
		],
	};
}

const CODEX_INVENTORY = {
	type: "additional_tools",
	id: "at_5b2c2c6b",
	role: "developer",
	tools: [
		{
			type: "namespace",
			name: "functions",
			description: "",
			tools: [
				{ type: "custom", name: "exec", description: "Run JavaScript" },
				{ type: "function", name: "wait", description: "Wait on a cell", parameters: { type: "object" } },
			],
		},
		{ type: "namespace", name: "clock", description: "", tools: [{ type: "function", name: "now" }] },
	],
};

const CODEX_HARNESS_ITEMS = [
	{ type: "message", role: "developer", content: [{ type: "input_text", text: CODEX_BASE_PROMPT }] },
	{
		type: "message",
		role: "developer",
		content: [
			{ type: "input_text", text: CODEX_MEMORY_BLOCK },
			{ type: "input_text", text: CODEX_SKILLS_BLOCK },
		],
	},
	{ type: "message", role: "developer", content: [{ type: "input_text", text: CODEX_SANDBOX_BLOCK }] },
];

const CODEX_USER_ITEMS = [
	{
		type: "message",
		role: "user",
		content: [
			{ type: "input_text", text: AMBIENT_AGENTS_MD },
			{ type: "input_text", text: AMBIENT_ENVIRONMENT_CONTEXT },
		],
	},
	{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
];

function codexBody(options: { fallbackMetadata: boolean }): Record<string, unknown> {
	return {
		model: "gpt-5.6-sol",
		stream: true,
		input: options.fallbackMetadata
			? [...CODEX_HARNESS_ITEMS.slice(1), ...CODEX_USER_ITEMS]
			: [CODEX_INVENTORY, ...CODEX_HARNESS_ITEMS, ...CODEX_USER_ITEMS],
		...(options.fallbackMetadata && {
			instructions: CODEX_BASE_PROMPT,
			tools: [{ type: "function", name: "shell", description: "Run a command" }],
		}),
		tool_choice: "auto",
		parallel_tool_calls: false,
		client_metadata: { session_id: "01a08918-e0fa-7222-99cd-d3577c4c3325", thread_id: "01a08918-e0fa" },
	};
}

const CODEX_HEADERS: Record<string, string> = {
	"content-type": "application/json",
	originator: CODEX_ENTRYPOINT,
	"user-agent": `${CODEX_ENTRYPOINT}/${CODEX_VERSION} (Ubuntu 26.4.0; x86_64) dumb (${CODEX_ENTRYPOINT}; ${CODEX_VERSION})`,
};

const ANTHROPIC_HEADERS: Record<string, string> = {
	"content-type": "application/json",
	"anthropic-version": "2023-06-01",
	"user-agent": `claude-cli/2.1.267 (external, cli)`,
	"x-app": "cli",
};

interface Gateway {
	url: string;
	mock: MockModel;
	handle: AuthGatewayServerHandle;
	storage: AuthStorage;
}

describe("harness capture recorder", () => {
	const dirs = withHarnessCacheDir("omp-harness-recorder-");
	const gateways: Gateway[] = [];

	async function bootGateway(options: { record: boolean }): Promise<Gateway> {
		registerMockApi();
		const storage = await AuthStorage.create(path.join(dirs.root, `auth-${gateways.length}.db`));
		storage.keys.setRuntime("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/harness-recorder" });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			storage,
			version: "test",
			resolveModel: () => mock.model,
			...(options.record && { harnessRecorder: recordHarnessRequest }),
		});
		const gateway: Gateway = { url: handle.url, mock, handle, storage };
		gateways.push(gateway);
		return gateway;
	}

	function post(
		gateway: Gateway,
		route: string,
		body: Record<string, unknown>,
		headers: Record<string, string>,
	): Promise<Response> {
		gateway.mock.push(MOCK_REPLY);
		return fetch(`${gateway.url}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
	}

	async function recordTurn(
		route: string,
		body: Record<string, unknown>,
		headers: Record<string, string>,
	): Promise<Response> {
		return post(await bootGateway({ record: true }), route, body, headers);
	}

	async function profileFiles(profile: HarnessProfile): Promise<string[]> {
		try {
			return (await fs.readdir(path.join(dirs.cache, profile))).sort();
		} catch {
			return [];
		}
	}

	async function readCapture(profile: HarnessProfile, file: string): Promise<unknown> {
		return await Bun.file(path.join(dirs.cache, profile, file)).json();
	}

	async function seedCapture(file: string, capturedAt: string): Promise<void> {
		const dir = path.join(dirs.cache, "claude-code");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, file),
			JSON.stringify({
				schema: HARNESS_CAPTURE_SCHEMA,
				profile: "claude-code",
				clientVersion: CLIENT_VERSION,
				entrypoint: claudeCodeEntrypoint,
				capturedAt,
				instructions: [
					`${claudeCodeBillingHeaderPrefix} cc_version=${CLIENT_VERSION}; cc_entrypoint=${claudeCodeEntrypoint};`,
					claudeCodeSystemInstruction,
					HARNESS_PROMPT_BLOCK,
				],
				tools: ["Bash", "Read"],
			}),
		);
	}
	function servedPrompt(profile: HarnessProfile) {
		resetHarnessPromptCache();
		return loadHarnessPrompt(profile);
	}

	afterEach(async () => {
		for (const gateway of gateways) {
			await gateway.handle.close();
			gateway.storage.close();
		}
		gateways.length = 0;
		clearCustomApis();
	});

	it("persists a Claude Code cli turn as a capture the reader then serves verbatim", async () => {
		await recordTurn("/v1/messages", claudeCodeBody(claudeCodeEntrypoint, false), ANTHROPIC_HEADERS);

		expect(await profileFiles("claude-code")).toEqual([
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		]);
		const capture = await readCapture(
			"claude-code",
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		);
		expect(isRecord(capture) ? capture.tools : undefined).toEqual(["Bash", "Read"]);
		expect(isRecord(capture) ? capture.declarations : undefined).toEqual([
			{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: {} } },
			{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
		]);
		expect(isRecord(capture) ? capture.instructions : undefined).toEqual([
			`${claudeCodeBillingHeaderPrefix} cc_version=${CLIENT_VERSION}; cc_entrypoint=${claudeCodeEntrypoint};`,
			claudeCodeSystemInstruction,
			HARNESS_PROMPT_BLOCK,
		]);

		const served = await servedPrompt("claude-code");
		expect(served?.clientVersion).toBe(CLIENT_VERSION);
		expect(served?.text).toBe(HARNESS_PROMPT_BLOCK);
		expect(served?.text).not.toContain(claudeCodeBillingHeaderPrefix);
		expect(served?.text).not.toContain(claudeCodeSystemInstruction);
	});

	it.skipIf(process.platform === "win32")("writes the capture owner-only", async () => {
		await recordTurn("/v1/messages", claudeCodeBody(claudeCodeEntrypoint, false), ANTHROPIC_HEADERS);

		const file = path.join(
			dirs.cache,
			"claude-code",
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		);
		const mode = (await fs.stat(file)).mode & 0o777;
		expect(mode.toString(8)).toBe("600");
	});

	it("refuses the sdk-cli entrypoint: another surface of the same client is a different target", async () => {
		const response = await recordTurn("/v1/messages", claudeCodeBody("sdk-cli", false), ANTHROPIC_HEADERS);

		expect(await profileFiles("claude-code")).toEqual([]);
		expect(await servedPrompt("claude-code")).toBeNull();
		expect(response.status).toBe(200);
	});

	it("never writes outside the cache when the client states a traversing version", async () => {
		const body = claudeCodeBody(claudeCodeEntrypoint, false);
		const system = [
			{ type: "text", text: `${claudeCodeBillingHeaderPrefix} cc_version=../../escaped; cc_entrypoint=cli;` },
			{ type: "text", text: claudeCodeSystemInstruction },
			{ type: "text", text: HARNESS_PROMPT_BLOCK },
		];

		await recordTurn("/v1/messages", { ...body, system }, ANTHROPIC_HEADERS);

		expect(await fs.readdir(dirs.root)).not.toContain("escaped-cli.json");
		expect(await profileFiles("claude-code")).toEqual([]);
	});

	it("never writes outside the cache when Codex states a traversing version", async () => {
		await recordTurn("/v1/responses", codexBody({ fallbackMetadata: false }), {
			...CODEX_HEADERS,
			"user-agent": `${CODEX_ENTRYPOINT}/../../x (Ubuntu 26.4.0; x86_64)`,
			version: "../../x",
		});

		expect(await fs.readdir(dirs.root)).not.toContain("x-codex_exec.json");
		expect(await profileFiles("codex")).toEqual([]);
	});

	it("refuses a Codex entrypoint that is not the surface omp impersonates", async () => {
		await recordTurn("/v1/responses", codexBody({ fallbackMetadata: false }), {
			...CODEX_HEADERS,
			originator: "codex_vscode",
		});

		expect(await profileFiles("codex")).toEqual([]);
		expect(await servedPrompt("codex")).toBeNull();
	});

	it("records Codex's namespaced surface and will not let the fallback-metadata path replace it", async () => {
		const gateway = await bootGateway({ record: true });

		await post(gateway, "/v1/responses", codexBody({ fallbackMetadata: false }), CODEX_HEADERS);

		const file = `${CODEX_VERSION}-${CODEX_ENTRYPOINT}.json`;
		expect(await profileFiles("codex")).toEqual([file]);
		const capture = await readCapture("codex", file);
		expect(isRecord(capture) ? capture.tools : undefined).toEqual(["exec", "wait", "now"]);
		const served = await servedPrompt("codex");
		expect(served?.text).toBe(CODEX_BASE_PROMPT);

		await post(gateway, "/v1/responses", codexBody({ fallbackMetadata: true }), CODEX_HEADERS);

		expect(await profileFiles("codex")).toEqual([file]);
		expect(await readCapture("codex", file)).toEqual(capture);
		expect((await servedPrompt("codex"))?.text).toBe(served?.text);
	});

	it("records only Codex's base prompt, never the recording machine's own developer blocks", async () => {
		await recordTurn("/v1/responses", codexBody({ fallbackMetadata: false }), CODEX_HEADERS);

		const capture = await readCapture("codex", `${CODEX_VERSION}-${CODEX_ENTRYPOINT}.json`);
		expect(isRecord(capture) ? capture.instructions : undefined).toEqual([CODEX_BASE_PROMPT]);

		const served = await servedPrompt("codex");
		expect(served?.text).toBe(CODEX_BASE_PROMPT);
		const stored = JSON.stringify(capture);
		for (const marker of ["## Memory", "<skills_instructions>", "danger-full-access"]) {
			expect(stored).not.toContain(marker);
		}
	});

	it("persists no user-side text when no recorded block carries any", async () => {
		await recordTurn("/v1/messages", claudeCodeBody(claudeCodeEntrypoint, false), ANTHROPIC_HEADERS);

		const capture = await readCapture(
			"claude-code",
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		);
		expect(isRecord(capture) ? capture.ambient : undefined).toEqual([]);
		const stored = JSON.stringify(capture);
		expect(stored).not.toContain("vault://prod");
		expect(stored).not.toContain("Primary working directory");
		expect(stored).not.toContain('"hi"');
	});

	it("keeps the user's own CLAUDE.md out of the harness prompt it records", async () => {
		const body = claudeCodeBody(claudeCodeEntrypoint, false);
		const folded = {
			...body,
			system: [
				{
					type: "text",
					text: `${claudeCodeBillingHeaderPrefix} cc_version=${CLIENT_VERSION}; cc_entrypoint=${claudeCodeEntrypoint};`,
				},
				{ type: "text", text: claudeCodeSystemInstruction },
				{ type: "text", text: HARNESS_PROMPT_BLOCK },
				{ type: "text", text: `${AMBIENT_CLAUDE_MD}\n\nFollow the instructions above.` },
			],
		};

		await recordTurn("/v1/messages", folded, ANTHROPIC_HEADERS);

		const capture = await readCapture(
			"claude-code",
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		);
		expect(isRecord(capture) ? capture.ambient : undefined).toEqual([AMBIENT_CLAUDE_MD]);

		const served = await servedPrompt("claude-code");
		expect(served?.text).toBe(HARNESS_PROMPT_BLOCK);
		expect(served?.text).not.toContain("vault://prod");
	});

	it("refreshes the capture when the same client identity re-records with a newer timestamp", async () => {
		await seedCapture(`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`, "2020-01-01T00:00:00.000Z");
		const gateway = await bootGateway({ record: true });
		const delegated = {
			...claudeCodeBody(claudeCodeEntrypoint, false),
			system: [
				{
					type: "text",
					text: `${claudeCodeBillingHeaderPrefix} cc_version=${CLIENT_VERSION}; cc_entrypoint=${claudeCodeEntrypoint};`,
				},
				{ type: "text", text: claudeCodeSystemInstruction },
				{ type: "text", text: SUBAGENT_PROMPT_BLOCK },
			],
		};

		const second = await post(gateway, "/v1/messages", delegated, ANTHROPIC_HEADERS);

		expect(await profileFiles("claude-code")).toEqual([
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		]);
		expect((await servedPrompt("claude-code"))?.text).toBe(SUBAGENT_PROMPT_BLOCK);
		expect(second.status).toBe(200);
	});

	it("keeps the recorded capture when a re-record arrives with an older timestamp", async () => {
		await seedCapture(`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`, "2999-01-01T00:00:00.000Z");
		const gateway = await bootGateway({ record: true });
		const delegated = {
			...claudeCodeBody(claudeCodeEntrypoint, false),
			system: [
				{
					type: "text",
					text: `${claudeCodeBillingHeaderPrefix} cc_version=${CLIENT_VERSION}; cc_entrypoint=${claudeCodeEntrypoint};`,
				},
				{ type: "text", text: claudeCodeSystemInstruction },
				{ type: "text", text: SUBAGENT_PROMPT_BLOCK },
			],
		};

		await post(gateway, "/v1/messages", delegated, ANTHROPIC_HEADERS);

		const capture = await readCapture(
			"claude-code",
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		);
		expect(isRecord(capture) ? capture.capturedAt : undefined).toBe("2999-01-01T00:00:00.000Z");
		expect((await servedPrompt("claude-code"))?.text).toBe(HARNESS_PROMPT_BLOCK);
	});

	it("never lets a request the capture contract rejects replace a valid capture", async () => {
		await seedCapture(`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`, "2020-01-01T00:00:00.000Z");
		const before = await readCapture("claude-code", `${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`);

		await recordTurn("/v1/messages", claudeCodeBody("sdk-cli", false), ANTHROPIC_HEADERS);

		expect(
			await readCapture("claude-code", `${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`),
		).toEqual(before);
		expect((await servedPrompt("claude-code"))?.text).toBe(HARNESS_PROMPT_BLOCK);
	});

	it("records nothing and answers identically when record mode is off", async () => {
		const recording = await bootGateway({ record: true });
		const plain = await bootGateway({ record: false });
		const body = claudeCodeBody(claudeCodeEntrypoint, false);

		const withRecord = await post(recording, "/v1/messages", body, ANTHROPIC_HEADERS);
		expect(await profileFiles("claude-code")).toEqual([
			`${CLIENT_VERSION}-${claudeCodeEntrypoint}-claude-sonnet-5.json`,
		]);
		await fs.rm(dirs.cache, { recursive: true, force: true });

		const withoutRecord = await post(plain, "/v1/messages", body, ANTHROPIC_HEADERS);

		expect(await profileFiles("claude-code")).toEqual([]);
		expect(await servedPrompt("claude-code")).toBeNull();
		expect(withoutRecord.status).toBe(withRecord.status);
		const served = await withRecord.json();
		const unserved = await withoutRecord.json();
		expect(isRecord(unserved) ? { ...unserved, id: "<id>" } : unserved).toEqual(
			isRecord(served) ? { ...served, id: "<id>" } : served,
		);
	});

	describe("real vendor recordings", () => {
		const captureDir = Bun.env.OMP_HARNESS_CAPTURE_DIR;

		it.skipIf(captureDir === undefined || captureDir.length === 0)(
			"records exactly the recordings whose surface is the one omp impersonates",
			async () => {
				const dir = captureDir ?? "";
				const names = (await fs.readdir(dir)).filter(name => name.endsWith(".json")).sort();
				expect(names.length).toBeGreaterThan(0);
				for (const name of names) {
					const body: unknown = await Bun.file(path.join(dir, name)).json();
					const shape = classifyRecording(body);
					await fs.rm(dirs.cache, { recursive: true, force: true });
					const gateway = await bootGateway({ record: true });
					gateway.mock.push(MOCK_REPLY);
					await post(gateway, shape.route, isRecord(body) ? body : {}, shape.headers);
					const served = await servedPrompt(shape.profile);
					if (!shape.recordable) {
						expect({ name, servedNothing: served === null }).toEqual({ name, servedNothing: true });
						continue;
					}
					expect({ name, served: served !== null }).toEqual({ name, served: true });
					expect(served?.text.startsWith(claudeCodeBillingHeaderPrefix)).toBe(false);
					for (const block of shape.ambient.filter(text => text.trim().length >= AMBIENT_NEEDLE_MIN_CHARS)) {
						expect({ name, leaked: served?.text.includes(block) }).toEqual({ name, leaked: false });
					}
				}
			},
		);
	});
});

describe("harness record mode boot guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses to start record mode where an unauthenticated remote client could author captures", () => {
		for (const bind of ["0.0.0.0:4000", "[::]:4000", "192.168.1.5:4000", "10.0.0.7:4000", "gateway.local:4000"]) {
			expect(() => assertHarnessRecordingConfined({ recordHarness: true, noAuth: true, bind })).toThrow();
		}
	});

	it("starts record mode when the capture author is confined to this machine or to bearer holders", () => {
		const confined: AuthGatewayCommandArgs["flags"][] = [
			{ recordHarness: true, noAuth: true },
			{ recordHarness: true, noAuth: true, bind: "127.0.0.1:4000" },
			{ recordHarness: true, noAuth: true, bind: "127.5.5.5:4000" },
			{ recordHarness: true, noAuth: true, bind: "[::1]:4000" },
			{ recordHarness: true, noAuth: true, bind: "localhost:4000" },
			{ recordHarness: true, bind: "0.0.0.0:4000" },
			{ noAuth: true, bind: "0.0.0.0:4000" },
		];
		for (const flags of confined) {
			expect(() => assertHarnessRecordingConfined(flags)).not.toThrow();
		}
	});

	it("refuses before the gateway resolves its broker, so nothing is listening", async () => {
		const broker = vi.spyOn(brokerConfig, "resolveAuthBrokerConfig").mockResolvedValue(null);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { recordHarness: true, noAuth: true, bind: "0.0.0.0:4000" } }),
		).rejects.toThrow();
		expect(broker).not.toHaveBeenCalled();

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { recordHarness: true, noAuth: true, bind: "127.0.0.1:0" } }),
		).rejects.toThrow();
		expect(broker).toHaveBeenCalledTimes(1);
	});
});

interface RecordingShape {
	profile: HarnessProfile;
	route: string;
	headers: Record<string, string>;
	recordable: boolean;
	ambient: string[];
}

function classifyRecording(body: unknown): RecordingShape {
	const system = isRecord(body) && Array.isArray(body.system) ? body.system : undefined;
	if (system !== undefined) {
		const header = system
			.flatMap(block => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
			.find(text => text.startsWith(claudeCodeBillingHeaderPrefix));
		const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
		return {
			profile: "claude-code",
			route: "/v1/messages",
			headers: ANTHROPIC_HEADERS,
			recordable: header?.includes(`cc_entrypoint=${claudeCodeEntrypoint};`) === true,
			ambient: messages.flatMap(message =>
				isRecord(message) && Array.isArray(message.content)
					? message.content.flatMap(part => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
					: [],
			),
		};
	}
	const input = isRecord(body) && Array.isArray(body.input) ? body.input : [];
	const inventory = input.some(item => isRecord(item) && item.type === "additional_tools");
	return {
		profile: "codex",
		route: "/v1/responses",
		headers: CODEX_HEADERS,
		recordable: inventory,
		ambient: input.flatMap(item =>
			isRecord(item) && item.role === "user" && Array.isArray(item.content)
				? item.content.flatMap(part => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
				: [],
		),
	};
}
