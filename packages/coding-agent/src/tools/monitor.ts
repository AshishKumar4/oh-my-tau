import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { formatDuration, isRecord, prompt } from "@oh-my-pi/pi-utils";
import { executeBash } from "../exec/bash-executor";
import { cfgBashGitGuard } from "../exec/settings";
import monitorDescription from "../prompts/tools/monitor.md" with { type: "text" };
import type { MonitorEvent } from "../session/monitor-events";
import { ovnfsCommand } from "../task/settings";
import type { ToolSession } from ".";
import { BashTool, toolCallSessionEnv } from "./bash";
import { ToolError } from "./tool-errors";

const monitorSchema = type({
	description: type("string").describe(
		"Short human-readable description of what you are monitoring (shown in notifications).",
	),
	timeout_ms: type("number").describe(
		"Kill the monitor after this deadline. Default 300000ms. Deadlines above 1800000ms are capped to 1800000ms. You are notified at expiry and can re-arm.",
	),
	"command?": type("string").describe("Shell command or script. Each stdout line is an event; exit ends the watch."),
	"ws?": type({ url: "string", "protocols?": "string[]" }).describe(
		"WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.",
	),
});

type MonitorParams = typeof monitorSchema.infer;

export interface MonitorToolDetails {
	jobId: string;
	description: string;
	timeoutMs: number;
}

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
/** Lines within this long of a batch's first line share one notification. */
const EVENT_BATCH_MS = 200;
/** More notifications than this inside {@link FLOOD_WINDOW_MS} stop the monitor. */
const FLOOD_LIMIT = 30;
const FLOOD_WINDOW_MS = 60_000;

/** How a watch ended. */
type MonitorEnd =
	| { kind: "exited"; code: number | undefined }
	| { kind: "closed"; code: number; reason: string }
	| { kind: "expired" }
	| { kind: "flooded" }
	| { kind: "cancelled" };

/**
 * Turns a monitor's output into notifications: complete stdout lines are
 * batched for {@link EVENT_BATCH_MS}, a WebSocket frame is one event, and a
 * flood stops the watch.
 */
class EventStream {
	#partial = "";
	#batch: string[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#sentAt: number[] = [];
	#flooded = false;
	count = 0;

	constructor(
		private readonly emit: (text: string) => void,
		private readonly onFlood: () => void,
	) {}

	pushChunk(chunk: string): void {
		const lines = (this.#partial + chunk).replace(/\r\n?/g, "\n").split("\n");
		this.#partial = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim() === "") continue;
			this.#batch.push(line);
			this.#timer ??= setTimeout(() => this.#flushBatch(), EVENT_BATCH_MS);
		}
	}

	pushEvent(text: string): void {
		this.#send(text);
	}

	/** The stream ended: deliver what is buffered, the unterminated last line included. */
	close(): void {
		if (this.#partial.trim() !== "") this.#batch.push(this.#partial);
		this.#partial = "";
		this.#flushBatch();
	}

	#flushBatch(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#batch.length === 0) return;
		const text = this.#batch.join("\n");
		this.#batch = [];
		this.#send(text);
	}

	#send(text: string): void {
		if (this.#flooded) return;
		const now = Date.now();
		this.#sentAt = this.#sentAt.filter(at => now - at < FLOOD_WINDOW_MS);
		if (this.#sentAt.length >= FLOOD_LIMIT) {
			this.#flooded = true;
			this.onFlood();
			return;
		}
		this.#sentAt.push(now);
		this.count++;
		this.emit(text);
	}
}

/** Single-quoted for a POSIX shell. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function plural(count: number): string {
	return `${count} event${count === 1 ? "" : "s"}`;
}

/** The notice a watch's end delivers: why it ended, its event count, and where its stderr went. */
function endNotice(jobId: string, description: string, end: MonitorEnd, count: number, timeoutMs: number): string {
	const name = `Monitor \`${jobId}\` (${description})`;
	switch (end.kind) {
		case "exited":
			return `${name} ended: its command exited with code ${end.code ?? "unknown"} after ${plural(count)}.`;
		case "closed":
			return `${name} ended: the socket closed with code ${end.code}${end.reason ? ` (${end.reason})` : ""} after ${plural(count)}.`;
		case "expired":
			return `${name} expired after ${formatDuration(timeoutMs)} with ${plural(count)}. Re-arm it to keep watching.`;
		case "flooded":
			return `${name} stopped: more than ${FLOOD_LIMIT} notifications in a minute (${plural(count)} delivered). Re-arm it with a tighter filter.`;
		case "cancelled":
			return `${name} was cancelled after ${plural(count)}.`;
	}
}

/**
 * Claude Code's `Monitor`: a background job that turns each line a script
 * prints (or each WebSocket frame) into a notification for the session that
 * started it, until the script exits, the socket closes, or it expires.
 * Notifications travel the session's completion-notice path, so they wake an
 * idle session and end a blocked `wait`.
 */
export class MonitorTool implements AgentTool<typeof monitorSchema, MonitorToolDetails> {
	readonly name = "monitor";
	readonly label = "Monitor";
	readonly summary = "Stream events from a long-running script or WebSocket as notifications";
	readonly description = prompt.render(monitorDescription);
	readonly parameters = monitorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<MonitorParams>) =>
		args.description ? `monitoring: ${args.description}` : "monitoring";
	/** The session's shell policy, applied to a monitor's command as to a background bash job. */
	readonly #bash: BashTool;

	constructor(private readonly session: ToolSession) {
		this.#bash = new BashTool(session);
	}

	readonly approval = (args: unknown, ctx?: AgentToolContext): ToolApprovalDecision => {
		const command = isRecord(args) && typeof args.command === "string" ? args.command : undefined;
		// A WebSocket only receives; a command runs under the same rules as bash.
		return command === undefined ? "read" : this.#bash.commandApproval(command, { managed: true }, ctx);
	};

	async execute(toolCallId: string, params: MonitorParams): Promise<AgentToolResult<MonitorToolDetails>> {
		const manager = this.session.asyncJobManager;
		const deliver = this.session.deliverMonitorEvent;
		if (!manager || !deliver) throw new ToolError("Monitors need background jobs, which this session does not run.");
		if ((params.command === undefined) === (params.ws === undefined)) {
			throw new ToolError("Give exactly one of `command` or `ws`.");
		}
		const description = params.description.trim() || "monitor";
		const timeoutMs = Math.min(Math.max(params.timeout_ms, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
		const env = toolCallSessionEnv(this.session, toolCallId);
		const sessionId = this.session.getSessionId?.() ?? undefined;

		const jobId = manager.register(
			"monitor",
			description,
			async ({ jobId, signal, reportProgress }) => {
				const stop = new AbortController();
				let ending: "expired" | "flooded" | undefined;
				const end = (why: "expired" | "flooded") => {
					ending ??= why;
					stop.abort();
				};
				const events = new EventStream(
					text => {
						const event: MonitorEvent = { jobId, description, text };
						deliver(event);
						void reportProgress(`${plural(events.count)}; latest: ${text.split("\n", 1)[0]}`);
					},
					() => end("flooded"),
				);
				const timer = setTimeout(() => end("expired"), timeoutMs);
				const watch = AbortSignal.any([signal, stop.signal]);
				let stderr: { id?: string; path?: string } | undefined;
				let outcome: MonitorEnd;
				try {
					if (params.command !== undefined) {
						stderr = await this.session.allocateOutputArtifact?.("monitor");
						const result = await executeBash(
							`{\n${params.command}\n} 2>>${shellQuote(stderr?.path ?? "/dev/null")}`,
							{
								cwd: this.session.cwd,
								env,
								// Its own per-job shell, released when the watch ends, like a background bash job's.
								sessionKey: `${sessionId ?? ""}:async:${jobId}`,
								timeout: 0,
								signal: watch,
								gitGuard: cfgBashGitGuard.get(this.session.settings),
								ovnfs: ovnfsCommand(this.session.settings),
								onChunk: chunk => events.pushChunk(chunk),
							},
						);
						events.close();
						outcome = result.cancelled ? { kind: "cancelled" } : { kind: "exited", code: result.exitCode };
					} else {
						outcome = await watchSocket(params.ws ?? { url: "" }, events, watch);
					}
				} finally {
					clearTimeout(timer);
				}
				if (ending) outcome = { kind: ending };
				let notice = endNotice(jobId, description, outcome, events.count, timeoutMs);
				if (stderr?.path && stderr.id && Bun.file(stderr.path).size > 0) {
					notice += ` Its stderr is at artifact://${stderr.id}.`;
				}
				return notice;
			},
			{ ownerId: this.session.getAgentId?.() ?? undefined },
		);
		return {
			content: [
				{
					type: "text",
					text: `Monitor \`${jobId}\` started (${description}); its events arrive as notifications. It expires in ${formatDuration(timeoutMs)}.`,
				},
			],
			details: { jobId, description, timeoutMs },
		};
	}
}

/** Stream a WebSocket's frames as events until it closes or `signal` ends the watch. */
function watchSocket(
	target: { url: string; protocols?: string[] },
	events: EventStream,
	signal: AbortSignal,
): Promise<MonitorEnd> {
	const { promise, resolve } = Promise.withResolvers<MonitorEnd>();
	const socket = new WebSocket(target.url, target.protocols);
	socket.binaryType = "arraybuffer";
	const onAbort = () => {
		resolve({ kind: "cancelled" });
		socket.close();
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	socket.addEventListener("message", event => {
		const data: unknown = event.data;
		if (typeof data === "string") events.pushEvent(data);
		else if (data instanceof ArrayBuffer) events.pushEvent(`[binary frame, ${data.byteLength} bytes]`);
	});
	socket.addEventListener("error", () => events.pushEvent(`WebSocket error on ${target.url}`));
	socket.addEventListener("close", event => {
		signal.removeEventListener("abort", onAbort);
		resolve({ kind: "closed", code: event.code, reason: event.reason });
	});
	return promise;
}
