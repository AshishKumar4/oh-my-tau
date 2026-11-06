import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { disposeAllKernelSessions } from "../../src/eval/py/executor";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-session-tool-timeout-");
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeSession(...tools: AgentTool[]): ToolSession {
	const sessionId = `session-tool-timeout-${crypto.randomUUID()}`;
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getEvalSessionId: () => sessionId,
		getToolByName: name => tools.find(tool => tool.name === name),
	};
}

/** A tool whose work stays in flight until the test calls `release()` (or the call is aborted). */
function slowTool(name: string): {
	tool: AgentTool;
	started: Promise<void>;
	release: () => void;
	aborted: () => boolean;
} {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let aborted = false;
	return {
		started: started.promise,
		release: () => released.resolve(),
		aborted: () => aborted,
		tool: {
			name,
			label: name,
			description: "Returns delegated work once released",
			parameters: type({}),
			async execute(_id, _args, signal) {
				const result = Promise.withResolvers<AgentToolResult>();
				void released.promise.then(() => result.resolve({ content: [{ type: "text", text: "review complete" }] }));
				const onAbort = () => {
					aborted = true;
					result.reject(signal?.reason);
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				started.resolve();
				try {
					return await result.promise;
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			},
		},
	};
}

async function warmEval(evalTool: EvalTool, language: "js" | "py"): Promise<void> {
	// Start the real worker/kernel outside the measured cell, so interpreter
	// startup cannot hide whether the delegated call reached execution.
	await evalTool.execute("warmup", { language, code: "print('ready')", timeout: 0 });
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe("eval delegated session tools", () => {
	for (const language of ["js", "py"] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: still aborts an awaited tool.task when the turn is cancelled`,
			async () => {
				const delegated = slowTool("task");
				const evalTool = new EvalTool(makeSession(delegated.tool));
				await warmEval(evalTool, language);
				const controller = new AbortController();
				const pending = evalTool.execute(
					"cancel-delegated-work",
					{ language, code: "print(await tool.task({}))", timeout: 1 },
					controller.signal,
				);

				await delegated.started;
				controller.abort(new Error("turn cancelled"));
				const result = await pending;
				expect(delegated.aborted()).toBe(true);
				expect(result.details?.cells?.[0]?.status).toBe("error");
				expect(result.details?.cells?.[0]?.output).not.toContain("review complete");
			},
			15_000,
		);
	}
	// Delegated work pauses the cell budget; the cell's own work does not.
	for (const name of ["task", "wait"] as const) {
		it(`js: returns tool.${name} work that outlasts a one-second cell budget`, async () => {
			const delegated = slowTool(name);
			const evalTool = new EvalTool(makeSession(delegated.tool));
			await warmEval(evalTool, "js");
			const pending = evalTool.execute("slow-delegated-work", {
				language: "js",
				code: `print(await tool.${name}({}))`,
				timeout: 1,
			});
			await delegated.started;
			await Bun.sleep(1_500);
			delegated.release();
			const result = await pending;
			expect(delegated.aborted()).toBe(false);
			expect(result.details?.cells?.[0]).toMatchObject({
				status: "complete",
				output: expect.stringContaining("review complete"),
			});
		}, 15_000);
	}

	it("js: still charges an ordinary tool call to the cell budget", async () => {
		const ordinary = slowTool("read");
		const evalTool = new EvalTool(makeSession(ordinary.tool));
		await warmEval(evalTool, "js");
		const result = await evalTool.execute("slow-read", {
			language: "js",
			code: "print(await tool.read({}))",
			timeout: 1,
		});
		expect(ordinary.aborted()).toBe(true);
		expect(result.details?.cells?.[0]?.output).toContain("timed out");
		expect(result.details?.cells?.[0]?.output).not.toContain("review complete");
	}, 15_000);

	it("js: interrupts a CPU loop that follows a delegated tool.task", async () => {
		const delegated = slowTool("task");
		const evalTool = new EvalTool(makeSession(delegated.tool));
		await warmEval(evalTool, "js");
		const pending = evalTool.execute("compute-after-delegated-work", {
			language: "js",
			code: "print(await tool.task({}));\nwhile (true) {}",
			timeout: 1,
		});
		await delegated.started;
		await Bun.sleep(1_500);
		delegated.release();
		const result = await pending;
		expect(delegated.aborted()).toBe(false);
		expect(result.details?.cells?.[0]?.output).toContain("review complete");
		expect(result.details?.cells?.[0]?.output).toContain("timed out");
	}, 15_000);
});
