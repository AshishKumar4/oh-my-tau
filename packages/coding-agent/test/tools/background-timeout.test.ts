import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager, type AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeVmContextsByOwner } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as toolTimeouts from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { Shell } from "@oh-my-pi/pi-natives";

const KERNEL_OWNER = "background-timeout-test";
const managers: AsyncJobManager[] = [];

function manager(maxRunningJobs?: number): AsyncJobManager {
	const jobs = new AsyncJobManager({ maxRunningJobs });
	managers.push(jobs);
	return jobs;
}

function session(settings: Settings, asyncJobManager?: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => KERNEL_OWNER,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
		settings,
		asyncJobManager,
	};
}

function job(manager: AsyncJobManager, id: string | undefined): AsyncJob {
	if (id === undefined) throw new Error("Expected a background job id");
	const running = manager.getJob(id);
	if (running === undefined) throw new Error(`Missing background job ${id}`);
	return running;
}

async function stillPending<T>(promise: Promise<T>): Promise<boolean> {
	let settled = false;
	const settle = () => {
		settled = true;
	};
	void promise.then(settle, settle);
	for (let turn = 0; turn < 50 && !settled; turn++) await Promise.resolve();
	return !settled;
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const jobs of managers.splice(0)) await jobs.dispose();
	await disposeVmContextsByOwner(KERNEL_OWNER);
});

describe("BashTool background deadlines", () => {
	function bashSession(autoBackground = false, jobs = manager()): ToolSession {
		return session(
			Settings.isolated({
				"async.enabled": true,
				"launch.enabled": false,
				"bash.autoBackground.enabled": autoBackground,
				"bash.autoBackground.thresholdMs": 5,
				"bashInterceptor.enabled": false,
				"bash.direnv": "off",
				"tools.maxTimeout": 1,
			}),
			jobs,
		);
	}

	function compressNativeDeadline(): void {
		// Exercise native cancellation without a five-minute sleep; disabled
		// deadlines must stay disabled rather than acquiring the injected limit.
		const run = Shell.prototype.run;
		vi.spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			return run.call(this, { ...options, timeoutMs: options.timeoutMs === undefined ? undefined : 25 }, onChunk);
		});
	}

	it("lets an explicit background command finish beyond the default deadline", async () => {
		compressNativeDeadline();
		const jobs = manager();
		const tool = new BashTool(bashSession(false, jobs));
		const result = await tool.execute("explicit-background", {
			command: "sleep 0.15; printf finished",
			async: true,
		});
		const background = job(jobs, result.details?.async?.jobId);
		await background.promise;

		expect(background.status).toBe("completed");
		expect(background.resultText).toContain("finished");
		expect(background.latestDetails?.timedOut).toBeUndefined();
	});

	it("lets Claude Code run_in_background finish without an explicit timeout", async () => {
		compressNativeDeadline();
		const jobs = manager();
		const tool = new BashTool({
			...bashSession(false, jobs),
			getActiveModel: () => getBundledModel("anthropic", "claude-opus-5"),
		});
		const result = await tool.execute("claude-background", {
			command: "sleep 0.15; printf facade-finished",
			run_in_background: true,
		});
		const background = job(jobs, result.details?.async?.jobId);
		await background.promise;

		expect(background.status).toBe("completed");
		expect(background.resultText).toContain("facade-finished");
	});

	it("lets an auto-backgrounded command outlive the default deadline", async () => {
		compressNativeDeadline();
		const jobs = manager();
		const tool = new BashTool(bashSession(true, jobs));
		const result = await tool.execute("auto-background", { command: "sleep 0.15; printf auto-finished" });
		const background = job(jobs, result.details?.async?.jobId);
		await background.promise;

		expect(background.status).toBe("completed");
		expect(background.resultText).toContain("auto-finished");
	});

	it("still applies the default deadline to a direct foreground command", async () => {
		compressNativeDeadline();
		const result = await new BashTool(bashSession()).execute("foreground-default", {
			command: "sleep 0.15; printf never-finished",
		});

		expect(result.isError).toBe(true);
		expect(result.details?.timedOut).toBe(true);
		expect(result.content.some(block => block.type === "text" && block.text.includes("never-finished"))).toBe(false);
	});

	it("honours an explicit foreground timeout and the global maximum", async () => {
		compressNativeDeadline();
		const result = await new BashTool(bashSession()).execute("foreground-explicit", {
			command: "sleep 0.15; printf never-finished",
			timeout: 5,
		});

		expect(result.isError).toBe(true);
		expect(result.details?.timedOut).toBe(true);
		expect(result.details?.timeoutSeconds).toBe(1);
		expect(result.details?.requestedTimeoutSeconds).toBe(5);
	});

	it("honours an explicit background timeout and the global maximum", async () => {
		compressNativeDeadline();
		const jobs = manager();
		const tool = new BashTool(bashSession(false, jobs));
		const result = await tool.execute("background-explicit", {
			command: "sleep 0.15; printf never-finished",
			timeout: 5,
			async: true,
		});
		const background = job(jobs, result.details?.async?.jobId);
		await background.promise;

		expect(background.status).toBe("failed");
		expect(background.errorText).toContain("Command timed out after 1 seconds");
		expect(background.latestDetails?.timedOut).toBe(true);
		expect(background.latestDetails?.timeoutSeconds).toBe(1);
		expect(background.latestDetails?.requestedTimeoutSeconds).toBe(5);
	});

	it("keeps the foreground deadline when auto-backgrounding cannot acquire a job slot", async () => {
		compressNativeDeadline();
		const jobs = manager(1);
		const occupied = Promise.withResolvers<string>();
		jobs.register("bash", "occupied slot", async () => occupied.promise);
		try {
			const result = await new BashTool(bashSession(true, jobs)).execute("capacity-foreground", {
				command: "sleep 0.15; printf never-finished",
			});

			expect(result.details?.timedOut).toBe(true);
			expect(result.details?.async).toBeUndefined();
		} finally {
			occupied.resolve("slot released");
			await jobs.waitForAll();
		}
	});
});

// The real eval worker has its own clock, outside Bun test's fake timers.
// Compress the host watchdog and await the worker's observable completion.
describe("EvalTool background deadlines", () => {
	function evalSession(autoBackground: boolean, jobs = manager()): ToolSession {
		return session(
			Settings.isolated({
				"launch.enabled": false,
				"eval.autoBackground.enabled": autoBackground,
				"eval.autoBackground.thresholdMs": 5,
				"tools.maxTimeout": 1,
			}),
			jobs,
		);
	}

	it("lets an auto-backgrounded cell finish beyond its default runtime budget", async () => {
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const jobs = manager();
		const result = await new EvalTool(evalSession(true, jobs)).execute("eval-default-background", {
			language: "js",
			code: "await Bun.sleep(150); print('cell-finished');",
		});
		const background = job(jobs, result.details?.async?.jobId);
		await background.promise;

		expect(background.status).toBe("completed");
		expect(background.resultText).toContain("cell-finished");
	});

	it("honours an explicit background cell timeout and the global maximum", async () => {
		const clamp = toolTimeouts.clampTimeout;
		vi.spyOn(toolTimeouts, "clampTimeout").mockImplementation(
			(tool, timeout, maximum) => clamp(tool, timeout, maximum) / 20,
		);
		const jobs = manager();
		const result = await new EvalTool(evalSession(true, jobs)).execute("eval-explicit-background", {
			language: "js",
			code: "await Bun.sleep(2000); print('never-finished');",
			timeout: 5,
		});
		const background = job(jobs, result.details?.async?.jobId);
		await background.promise;

		expect(background.status).toBe("failed");
		expect(background.errorText).toContain("timed out");
		expect(background.errorText).not.toContain("never-finished");
	});

	it("retains the default runtime budget when auto-backgrounding is disabled", async () => {
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const result = await new EvalTool(evalSession(false)).execute("eval-foreground-default", {
			language: "js",
			code: "await Bun.sleep(2000); print('never-finished');",
		});

		expect(result.isError).toBe(true);
		expect(result.details?.cells?.[0]?.status).toBe("error");
		expect(result.content.some(block => block.type === "text" && block.text.includes("timed out"))).toBe(true);
	});
});

it("wait stays blocked past thirty minutes and returns a running snapshot at two hours", async () => {
	vi.useFakeTimers();
	const jobs = manager();
	const run = Promise.withResolvers<string>();
	const id = jobs.register("bash", "long suite", async () => run.promise);
	const waiting = new WaitTool(session(Settings.isolated({ "launch.enabled": false }), jobs)).execute("cap", {});
	try {
		vi.advanceTimersByTime(30 * 60_000);
		expect(await stillPending(waiting)).toBe(true);
		vi.advanceTimersByTime(90 * 60_000 - 1);
		expect(await stillPending(waiting)).toBe(true);
		vi.advanceTimersByTime(1);
		const result = await waiting;
		expect(result.details?.jobs).toEqual([expect.objectContaining({ id, status: "running" })]);
		expect(jobs.getJob(id)?.status).toBe("running");
	} finally {
		run.resolve("suite complete");
		await jobs.waitForAll();
	}
});
