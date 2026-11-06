import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, agentLoopContinue, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AssistantMessage, FetchImpl, Message, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { kResponsesReplayItem, type ResponsesReplayItemCarrier } from "@oh-my-pi/pi-ai/utils/block-symbols";

function sse(events: object[]): Response {
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

it("refuses ambiguous legacy native collisions before execution without rewriting historical input", async () => {
	const parameters = type({ value: "string" });
	let executions = 0;
	const tool: AgentTool<typeof parameters> = {
		name: "fixture",
		label: "Fixture",
		description: "Fixture",
		parameters,
		async execute() {
			executions++;
			return { content: [{ type: "text", text: "unexpected" }] };
		},
	};
	const mock = createMockModel();
	const message: AssistantMessage = {
		role: "assistant",
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "toolUse",
		timestamp: 1,
		content: [
			{ type: "toolCall", id: "call_legacy|fc_legacy", name: "fixture", arguments: { value: "one" } },
			{ type: "toolCall", id: "call_legacy|fc_legacy", name: "fixture", arguments: { value: "two" } },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: [
				{
					type: "function_call",
					call_id: "call_legacy",
					id: "fc_legacy",
					name: "fixture",
					arguments: '{"value":"past"}',
				},
				{ type: "function_call_output", call_id: "call_legacy", output: "historical output" },
				{ role: "user", content: "next" },
				{
					type: "function_call",
					call_id: "call_legacy",
					id: "fc_legacy",
					name: "fixture",
					arguments: '{"value":"one"}',
				},
				{
					type: "function_call",
					call_id: "call_legacy",
					id: "fc_legacy",
					name: "fixture",
					arguments: '{"value":"two"}',
				},
			],
		},
	};
	const original = JSON.stringify(message.providerPayload);
	const stream = agentLoopContinue(
		{ systemPrompt: ["system"], tools: [tool], messages: [message] },
		{
			model: mock.model,
			convertToLlm: messages =>
				messages.filter((message): message is Message =>
					["user", "developer", "assistant", "toolResult"].includes(message.role),
				),
		},
		undefined,
		mock.stream,
	);
	await expect(
		(async () => {
			for await (const _event of stream) {
			}
		})(),
	).rejects.toThrow("original output-item association");
	expect(executions).toBe(0);
	expect(JSON.stringify(message.providerPayload)).toBe(original);
});

it.each(["custom", "computer", "computer-done-only", "computer-done-only-no-prefix", "computer-done-only-open-prefix"])(
	"preserves native item kind and metadata while repairing %s calls",
	async kind => {
		const model = buildModel({
			id: "gpt-6-astra",
			name: "Fixture",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			supportsComputerUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 8192,
			preferWebsockets: false,
		});
		const parameters = type({ "input?": "string" });
		const execution: string[] = [];
		const tool: AgentTool<typeof parameters> = {
			name: kind === "custom" ? "fixture" : "computer",
			label: "Fixture",
			description: "Fixture",
			parameters,
			...(kind === "custom"
				? { customWireName: "fixture", customFormat: { syntax: "regex", definition: ".*" } }
				: {}),
			async execute(id, args) {
				execution.push(id);
				return kind === "custom"
					? { content: [{ type: "text", text: `result-${args.input}` }] }
					: {
							content: [{ type: "text", text: "screenshot" }],
							providerMetadata: {
								type: "computer",
								screenshot: { type: "computer_screenshot", file_id: "file_fixture" },
								acknowledgedSafetyChecks: [],
							},
						};
			},
		};
		const calls = [0, 1].map(index =>
			kind === "custom"
				? {
						type: "custom_tool_call",
						id: `ctc_${index}`,
						call_id: "reused",
						name: "fixture",
						input: `input-${index}`,
					}
				: {
						type: "computer_call",
						id: `cu_${index}`,
						call_id: "reused",
						action: { type: "screenshot" },
						pending_safety_checks: [],
					},
		);
		const prefix = { type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-fixed", summary: [] };
		let nextInput: object[] = [];
		let request = 0;
		const fetch: FetchImpl = async (_url, options) => {
			const data = options?.body;
			const payload = JSON.parse(
				typeof data === "string"
					? data
					: data instanceof Uint8Array
						? new TextDecoder().decode(Bun.zstdDecompressSync(data))
						: "{}",
			);
			if (++request === 1) {
				return sse([
					...(kind === "computer-done-only-no-prefix"
						? []
						: [
								{ type: "response.output_item.added", output_index: 0, item: prefix },
								...(kind === "computer-done-only-open-prefix"
									? []
									: [{ type: "response.output_item.done", output_index: 0, item: prefix }]),
							]),
					...calls.flatMap((item, index) =>
						kind.startsWith("computer-done-only")
							? [
									{
										type: "response.output_item.done",
										...(kind === "computer-done-only-open-prefix" ? {} : { output_index: index + 1 }),
										item,
									},
								]
							: [
									{ type: "response.output_item.added", output_index: index + 1, item },
									{ type: "response.output_item.done", output_index: index + 1, item },
								],
					),
					...(kind === "computer-done-only-open-prefix"
						? [{ type: "response.output_item.done", output_index: 0, item: prefix }]
						: []),
					{
						type: "response.completed",
						response: {
							id: "resp_tools",
							status: "completed",
							usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
						},
					},
				]);
			}
			if (!isRecord(payload) || !Array.isArray(payload.input)) throw new Error("Expected replay input");
			nextInput = payload.input.filter(isRecord);
			const item = {
				type: "message",
				id: "msg_done",
				role: "assistant",
				content: [{ type: "output_text", text: "Done" }],
			};
			return sse([
				{ type: "response.output_item.added", item },
				{ type: "response.output_item.done", item },
				{
					type: "response.completed",
					response: {
						id: "resp_done",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			]);
		};
		const states = new Map<string, ProviderSessionState>();
		const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toBase64()}.fixture`;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["system"], tools: [tool], messages: [] },
			streamFn: (_model, context, options) =>
				streamOpenAICodexResponses(model, context, {
					...options,
					apiKey: token,
					fetch,
					providerSessionState: states,
					preferWebsockets: false,
				}),
		});
		try {
			await agent.prompt("Run native calls");
			expect(execution).toHaveLength(2);
			expect(new Set(execution).size).toBe(2);
			const items = nextInput.filter(isRecord);
			const native = items.filter(item => item.type === (kind === "custom" ? "custom_tool_call" : "computer_call"));
			expect(native).toHaveLength(2);
			for (const item of native)
				expect(
					items.find(
						output =>
							output.type === (kind === "custom" ? "custom_tool_call_output" : "computer_call_output") &&
							output.call_id === item.call_id,
					),
				).toBeDefined();
			const assistant = agent.state.messages.find(
				message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"),
			);
			if (!assistant || assistant.role !== "assistant") throw new Error("Expected persisted native calls");
			if (kind === "computer-done-only-open-prefix") {
				if (assistant.providerPayload?.type !== "openaiResponsesHistory")
					throw new Error("Expected native payload");
				expect(assistant.providerPayload.items.find(item => item.type === "reasoning")).toEqual(prefix);
			}
			for (const block of assistant.content) {
				if (block.type !== "toolCall" || block.providerMetadata?.type !== "computer") continue;
				expect(native.some(item => item.id === block.providerMetadata?.providerItemId)).toBe(true);
				expect(block.providerMetadata.actions).toEqual([{ type: "screenshot" }]);
			}
			expect(prefix).toEqual({
				type: "reasoning",
				id: "rs_fixture",
				encrypted_content: "opaque-fixed",
				summary: [],
			});
		} finally {
			for (const state of states.values()) state.close();
		}
	},
);

it("keeps blank calls distinct across prompts and cold history while preserving opaque IDs", async () => {
	const parameters = type({ value: "string" });
	const executions: Array<{ id: string; value: string }> = [];
	const tool: AgentTool<typeof parameters> = {
		name: "fixture",
		label: "Fixture",
		description: "Fixture",
		parameters,
		concurrency: "shared",
		async execute(id, args) {
			executions.push({ id, value: args.value });
			return { content: [{ type: "text", text: args.value }] };
		},
	};
	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", id: "", name: "fixture", arguments: { value: "first" } },
					{ type: "toolCall", id: "   ", name: "fixture", arguments: { value: "second" } },
				],
			},
			{ content: ["Done"] },
			{
				content: [
					{ type: "toolCall", id: "", name: "fixture", arguments: { value: "third" } },
					{ type: "toolCall", id: "opaque|a", name: "fixture", arguments: { value: "fourth" } },
					{ type: "toolCall", id: "opaque|b", name: "fixture", arguments: { value: "fifth" } },
				],
			},
			{ content: ["Done"] },
		],
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["system"], tools: [tool], messages: [] },
		streamFn: mock.stream,
	});
	await agent.prompt("First");
	await agent.prompt("Second");
	const history: AgentMessage[] = JSON.parse(JSON.stringify(agent.state.messages));
	const marked = agent.state.messages.find(
		message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"),
	);
	if (!marked || marked.role !== "assistant") throw new Error("Expected live finalized tool turn");
	const firstCall = marked.content.find(block => block.type === "toolCall");
	if (!firstCall || firstCall.type !== "toolCall") throw new Error("Expected finalized call");
	const resumedMock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: firstCall.id, name: "fixture", arguments: { value: "after-resumed" } }] },
			{ content: ["Done"] },
		],
	});
	const resumedExecutions: string[] = [];
	const resumedTool: AgentTool<typeof parameters> = {
		...tool,
		async execute(id, args) {
			resumedExecutions.push(id);
			return { content: [{ type: "text", text: args.value }] };
		},
	};
	const resumed = agentLoopContinue(
		{ systemPrompt: ["system"], tools: [resumedTool], messages: [marked] },
		{
			model: resumedMock.model,
			convertToLlm: messages =>
				messages.filter((message): message is Message =>
					["user", "developer", "assistant", "toolResult"].includes(message.role),
				),
		},
		undefined,
		resumedMock.stream,
	);
	for await (const _event of resumed) {
	}
	expect(resumedExecutions[0]).toBe(firstCall.id);
	expect(new Set(resumedExecutions).size).toBe(resumedExecutions.length);
	const previous = executions[0];
	if (!previous) throw new Error("Expected previous execution");
	const reopened = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: previous.id, name: "fixture", arguments: { value: "sixth" } }] },
			{ content: ["Done"] },
		],
	});
	const cold = new Agent({
		initialState: { model: reopened.model, systemPrompt: ["system"], tools: [tool], messages: history },
		streamFn: reopened.stream,
	});
	await cold.prompt("After reopen");
	expect(executions.map(entry => entry.value)).toEqual(["first", "second", "third", "fourth", "fifth", "sixth"]);
	expect(new Set(executions.map(entry => entry.id)).size).toBe(6);
	expect(executions.every(entry => entry.id.trim().length > 0)).toBe(true);
	expect(executions.find(entry => entry.value === "fourth")?.id).toBe("opaque|a");
	expect(executions.find(entry => entry.value === "fifth")?.id).toBe("opaque|b");
	const resumable: AssistantMessage = {
		role: "assistant",
		api: mock.model.api,
		provider: mock.model.provider,
		model: mock.model.id,
		content: [{ type: "toolCall", id: "unpaired-tail", name: "fixture", arguments: { value: "resumed" } }],
		stopReason: "toolUse",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const continuation = createMockModel({ responses: [{ content: ["Done"] }] });
	const stream = agentLoopContinue(
		{ systemPrompt: ["system"], tools: [tool], messages: [...cold.state.messages, resumable] },
		{
			model: continuation.model,
			convertToLlm: messages =>
				messages.filter((message): message is Message =>
					["user", "developer", "assistant", "toolResult"].includes(message.role),
				),
		},
		undefined,
		continuation.stream,
	);
	for await (const _event of stream) {
	}
	expect(executions.at(-1)).toEqual({ id: "unpaired-tail", value: "resumed" });
});

for (const api of ["openai-responses", "openai-codex-responses"]) {
	it.each(api === "openai-codex-responses" ? ["sse", "sse-full", "websocket", "websocket-full"] : ["sse", "sse-full"])(
		`pairs calls across two prompts and native ${api} replay via %s`,
		async mode => {
			const fullSnapshot = mode.endsWith("full");
			const websocket = mode.startsWith("websocket");
			let handshakes = 0;
			const server = websocket
				? Bun.serve({
						hostname: "127.0.0.1",
						port: 0,
						fetch(request, server) {
							if (server.upgrade(request)) return undefined;
							return new Response("upgrade", { status: 400 });
						},
						websocket: {
							open() {
								handshakes++;
							},
							async message(socket, data) {
								const response = await fetch("https://fixture.invalid", { method: "POST", body: String(data) });
								for (const event of (await response.text()).split("\n\n"))
									if (event.startsWith("data: ")) socket.send(event.slice(6));
							},
						},
					})
				: undefined;
			const generic = buildModel({
				id: "fixture",
				name: "Fixture",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8192,
			});
			const codex = buildModel({
				id: "gpt-5.6-sol",
				name: "Fixture",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: server ? `http://127.0.0.1:${server.port}` : "https://chatgpt.com/backend-api",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8192,
				preferWebsockets: websocket,
			});
			const parameters = type({ value: "string" });
			const executions: Array<{ id: string; value: string }> = [];
			const tool: AgentTool<typeof parameters> = {
				name: "fixture",
				label: "Fixture",
				description: "Fixture",
				parameters,
				concurrency: "shared",
				async execute(id, args) {
					executions.push({ id, value: args.value });
					return { content: [{ type: "text", text: `result-${args.value}` }] };
				},
			};
			const requests: object[] = [];
			const preservedSnapshots: Array<{ input: object[]; serialized: string }> = [];
			const states = new Map<string, ProviderSessionState>();
			let request = 0;
			const fetch: FetchImpl = async (_url, options) => {
				const body = options?.body;
				const raw =
					typeof body === "string"
						? body
						: body instanceof Uint8Array
							? new TextDecoder().decode(Bun.zstdDecompressSync(body))
							: "";
				const payload = JSON.parse(raw);
				if (!isRecord(payload)) throw new Error("Expected request body");
				requests.push(payload);
				const turn = ++request;
				if (turn % 2 === 0) {
					const item = {
						type: "message",
						id: `msg_${turn}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Done" }],
					};
					return sse([
						{ type: "response.output_item.added", item },
						{ type: "response.output_item.done", item },
						{
							type: "response.completed",
							response: {
								id: `resp_${turn}`,
								status: "completed",
								usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
							},
						},
					]);
				}
				const first = {
					type: "function_call",
					id: "fc_first",
					call_id: "call_repeat",
					name: "fixture",
					arguments: JSON.stringify({ value: `${turn}-first` }),
				};
				const second = { ...first, id: "fc_second", arguments: JSON.stringify({ value: `${turn}-second` }) };
				return sse([
					{ type: "response.created", response: { id: `resp_${turn}` } },
					{ type: "response.output_item.added", output_index: 0, item: { ...first, arguments: "" } },
					{ type: "response.output_item.added", output_index: 1, item: { ...second, arguments: "" } },
					{ type: "response.output_item.done", output_index: 1, item: second },
					{ type: "response.output_item.done", output_index: 0, item: first },
					{
						type: "response.completed",
						response: {
							id: `resp_${turn}`,
							status: "completed",
							usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
						},
					},
				]);
			};
			const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toBase64()}.fixture`;
			const agent = new Agent({
				initialState: {
					model: api === "openai-responses" ? generic : codex,
					systemPrompt: ["system"],
					messages: [],
					tools: [tool],
				},
				streamFn: (_model, context, options) =>
					api === "openai-responses"
						? streamOpenAIResponses(generic, context, {
								...options,
								apiKey: "fixture",
								fetch,
								providerSessionState: states,
							})
						: streamOpenAICodexResponses(codex, context, {
								...options,
								apiKey: token,
								sessionId: "call-identity-fixture",
								fetch,
								providerSessionState: states,
								preferWebsockets: websocket,
							}),
				transformAssistantMessage: assistant => {
					if (!fullSnapshot || assistant.providerPayload?.type !== "openaiResponsesHistory") return;
					const requestBody = requests.at(-1);
					if (!requestBody || !("input" in requestBody) || !Array.isArray(requestBody.input))
						throw new Error("Expected actual request input");
					const prefix = requestBody.input.filter(isRecord);
					preservedSnapshots.push({ input: prefix, serialized: JSON.stringify(prefix) });
					for (const block of assistant.content) {
						if (block.type !== "toolCall") continue;
						const carrier: ResponsesReplayItemCarrier = block;
						const locator = carrier[kResponsesReplayItem];
						if (locator) carrier[kResponsesReplayItem] = { ...locator, index: locator.index + prefix.length };
					}
					assistant.providerPayload = {
						...assistant.providerPayload,
						dt: false,
						items: [...prefix, ...assistant.providerPayload.items],
					};
				},
			});
			try {
				await agent.prompt("First pair");
				await agent.prompt("Second pair");
				expect(executions.map(entry => entry.value)).toEqual(["1-first", "1-second", "3-first", "3-second"]);
				expect(new Set(executions.map(entry => entry.id)).size).toBe(4);
				for (const snapshot of preservedSnapshots) expect(JSON.stringify(snapshot.input)).toBe(snapshot.serialized);
				for (const index of [1, 3]) {
					const payload = requests[index];
					if (!payload || !("input" in payload) || !Array.isArray(payload.input))
						throw new Error("Expected native replay input");
					const items = payload.input.filter(isRecord);
					if (websocket)
						expect("previous_response_id" in payload ? payload.previous_response_id : undefined).toBeUndefined();
					const calls = items.filter(item => item.type === "function_call");
					const outputs = items.filter(item => item.type === "function_call_output");
					expect(calls.length).toBe(index + 1);
					for (const call of calls) {
						if (typeof call.arguments !== "string") throw new Error("Expected native arguments");
						const args = JSON.parse(call.arguments);
						if (!isRecord(args)) throw new Error("Expected decoded arguments");
						expect(outputs.find(output => output.call_id === call.call_id)?.output).toBe(`result-${args.value}`);
					}
					expect(JSON.stringify(payload.input)).not.toContain("Orphan");
				}
				if (websocket) expect(handshakes).toBe(1);
			} finally {
				for (const state of states.values()) state.close();
				await server?.stop(true);
			}
		},
	);
}
