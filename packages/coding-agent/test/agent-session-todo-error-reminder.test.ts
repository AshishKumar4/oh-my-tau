/**
 * Regression coverage for issue #16001: a failed `todo` call queues a hidden
 * `todo-error-reminder` for the next turn. The reminder exists to force a
 * corrected retry, so once a later `todo` mutation succeeds it is stale — its
 * embedded failure-time list snapshot would resurface finished work as open.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const REMINDER_MARKER = "todo failed, so todo progress is not visible to the user.";

function todoCall(id: string, args: Record<string, unknown>): MockResponse {
	const call: ToolCall = { type: "toolCall", id, name: "todo", arguments: args };
	return { content: [call] };
}

describe("AgentSession todo-error reminder", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-todo-error-reminder-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	/** Runs one scripted prompt plus a follow-up prompt; returns the serialized follow-up model context. */
	async function runTwoPrompts(firstRun: MockResponse[]): Promise<string> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const mock = createMockModel({ responses: [...firstRun, { content: ["Next answer"] }] });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.reminders": false,
			"tools.xdev": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const todo = new TodoTool({
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
			getTodoPhases: () => session?.getTodoPhases() ?? [],
			setTodoPhases: phases => session?.setTodoPhases(phases),
		});
		const agent = new Agent({
			getApiKey: agentModel => `${agentModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [todo], messages: [] },
			streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
			convertToLlm,
		});
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setTodoPhases([
			{ name: "Build", tasks: [{ content: "Write code", status: "in_progress" }] },
			{ name: "Ship", tasks: [{ content: "Release", status: "pending" }] },
		]);

		await session.prompt("Plan more work");
		await session.waitForIdle();
		await session.prompt("Next request");
		await session.waitForIdle();

		const lastCall = mock.calls.at(-1);
		if (!lastCall) throw new Error("Expected the mock model to be called");
		return JSON.stringify(lastCall.context.messages);
	}

	it("drops the queued reminder once a later todo mutation succeeds", async () => {
		const context = await runTwoPrompts([
			todoCall("todo-fail", { op: "append", items: ["Add tests"] }),
			todoCall("todo-retry", { op: "append", phase: "Build", items: ["Add tests"] }),
			{ content: ["Appended"] },
		]);

		expect(session?.getTodoPhases()[0]?.tasks.map(task => task.content)).toEqual(["Write code", "Add tests"]);
		expect(context).not.toContain(REMINDER_MARKER);
	});

	it("still delivers the reminder when the failure was never corrected", async () => {
		const context = await runTwoPrompts([
			todoCall("todo-fail", { op: "append", items: ["Add tests"] }),
			todoCall("todo-view", { op: "view" }),
			{ content: ["Gave up"] },
		]);

		expect(context).toContain(REMINDER_MARKER);
	});
});
