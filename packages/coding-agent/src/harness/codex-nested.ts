/**
 * Codex nested-tool aliases: the real Codex client folds its built-in tools
 * (exec_command, apply_patch, view_image, the goal trio, write_stdin) into
 * `exec`'s `tools.*` namespace instead of declaring them on the wire. Under
 * the "codex" harness profile the eval JS bridge resolves those vendor names
 * onto omp's tools so exec cells see the surface Codex models are trained
 * against — additively, on top of the omp tools that keep their own names.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { servedHarnessPrompt } from "./capture";

/** Context handed to alias implementations that need more than a params rewrite. */
export interface CodexNestedCallContext {
	session: ToolSession;
	/** Invoke an enabled omp tool by name; returns the bridge-normalized result. */
	invoke: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
	/** Wall-clock seconds since the alias call started. */
	elapsedSeconds: () => number;
}

/**
 * One vendor `tools.<name>` entry: the omp tool it delegates to plus the
 * argument/result translation. `call` overrides the default
 * `toParams → invoke → fromResult` flow for aliases that must branch
 * mid-call (write_stdin) or need the original arguments at result time
 * (view_image).
 */
/** What an alias hands back to the isolate: the vendor's record shape, or a bare string. */
export type CodexNestedValue = string | Record<string, unknown>;

export interface CodexNestedAlias {
	/** Vendor tool name as called from exec cells (`tools.exec_command`). */
	name: string;
	/** One-line description surfaced through `ALL_TOOLS` and the `tools` proxy catalog. */
	summary: string;
	/** omp tool the alias delegates to; resolves only while the target is bridge-enabled. */
	target: string;
	toParams?: (args: Record<string, unknown>) => Record<string, unknown>;
	fromResult?: (result: unknown, elapsedSeconds: number) => CodexNestedValue;
	call?: (args: Record<string, unknown>, ctx: CodexNestedCallContext) => Promise<CodexNestedValue>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Extract the model-facing text out of a bridge-normalized tool result. */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	const record = asRecord(result);
	if (record && typeof record.text === "string") return record.text;
	if (result === undefined || result === null) return "";
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

function resultDetails(result: unknown): Record<string, unknown> | undefined {
	return asRecord(asRecord(result)?.details);
}

function resultFailed(result: unknown): boolean {
	return asRecord(result)?.hasError === true;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Vendor `yield_time_ms` (milliseconds) → omp `timeout` (seconds), floor of 1s. */
function yieldTimeoutSeconds(args: Record<string, unknown>): number | undefined {
	const yieldMs = numberArg(args, "yield_time_ms");
	if (yieldMs === undefined || yieldMs <= 0) return undefined;
	return Math.max(1, Math.round(yieldMs / 1000));
}

/**
 * exec_command shape: `{ output, exit_code?, session_id?, wall_time_seconds? }`.
 * `exit_code` rides in bash details only on non-zero exits; a clean result is
 * 0 by definition. `session_id` appears only while the command still runs —
 * omp reports that as a backgrounded bash job (`details.async.jobId`).
 */
function execCommandResult(result: unknown, elapsedSeconds: number): Record<string, unknown> {
	const details = resultDetails(result);
	const asyncState = asRecord(details?.async);
	const sessionId = typeof asyncState?.jobId === "string" ? asyncState.jobId : undefined;
	const output: Record<string, unknown> = {
		output: resultText(result),
		wall_time_seconds: elapsedSeconds,
	};
	if (sessionId !== undefined) {
		output.session_id = sessionId;
		return output;
	}
	const exitCode = typeof details?.exitCode === "number" ? details.exitCode : resultFailed(result) ? 1 : 0;
	output.exit_code = exitCode;
	return output;
}

/** `JobSnapshot.status` → a coarse process exit code for write_stdin polls. */
function settledExitCode(status: unknown): number {
	switch (status) {
		case "completed":
			return 0;
		case "cancelled":
			return 130;
		default:
			return 1;
	}
}

async function writeStdinCall(
	args: Record<string, unknown>,
	ctx: CodexNestedCallContext,
): Promise<Record<string, unknown>> {
	const sessionId = args.session_id;
	if (sessionId === undefined || sessionId === null) {
		throw new ToolError("write_stdin requires session_id");
	}
	const id = String(sessionId);
	const chars = stringArg(args, "chars");
	if (chars === undefined || chars === "") {
		const result = await ctx.invoke("hub", {
			op: "wait",
			ids: [id],
			timeoutMs: numberArg(args, "yield_time_ms") ?? 5000,
		});
		const output: Record<string, unknown> = {
			output: resultText(result),
			wall_time_seconds: ctx.elapsedSeconds(),
		};
		const jobs = asRecord(resultDetails(result)?.jobs)?.jobs;
		const snapshot = Array.isArray(jobs) ? asRecord(jobs[0]) : undefined;
		if (snapshot && snapshot.status !== "running") {
			output.exit_code = settledExitCode(snapshot.status);
		} else {
			output.session_id = id;
		}
		return output;
	}
	// exec_command sessions background as omp async jobs, which have no stdin —
	// only hub-launched processes take input, and hub surfaces its own error
	// for names that match neither.
	if (ctx.session.asyncJobManager?.getJob(id)) {
		throw new ToolError(
			"background jobs have no stdin; start interactive processes with tools.hub({op:'start', ...}) and write with {op:'send'}",
		);
	}
	const result = await ctx.invoke("hub", { op: "send", name: id, text: chars });
	if (resultFailed(result)) {
		throw new ToolError(resultText(result) || `no interactive process named ${id}`);
	}
	return { output: resultText(result), wall_time_seconds: ctx.elapsedSeconds(), session_id: id };
}

async function viewImageCall(args: Record<string, unknown>, ctx: CodexNestedCallContext): Promise<CodexNestedValue> {
	const path = stringArg(args, "path");
	if (!path) throw new ToolError("view_image requires path");
	const result = await ctx.invoke("read", { path });
	const images = asRecord(result)?.images;
	const first = Array.isArray(images) ? asRecord(images[0]) : undefined;
	if (!first || typeof first.data !== "string" || typeof first.mimeType !== "string") {
		throw new ToolError(`read returned no image for ${path}`);
	}
	return {
		image_url: `data:${first.mimeType};base64,${first.data}`,
		detail: stringArg(args, "detail") ?? "high",
		// The bridge surfaces `images` entries to the model as real image
		// content, matching the direct read path.
		images: [{ mimeType: first.mimeType, data: first.data }],
	};
}

function updateGoalParams(args: Record<string, unknown>): Record<string, unknown> {
	switch (args.status) {
		case "complete":
			return { op: "complete" };
		case "blocked":
			throw new ToolError(
				"omp goals have no blocked state; the goal stays active — report the impasse in your reply",
			);
		default:
			throw new ToolError('update_goal status must be "complete" or "blocked"');
	}
}

const CODEX_NESTED_ALIASES: readonly CodexNestedAlias[] = [
	{
		name: "exec_command",
		summary: "Run a shell command and return its output (bridges to omp's bash tool).",
		target: "bash",
		toParams: args => ({
			command: stringArg(args, "cmd") ?? "",
			...(stringArg(args, "workdir") !== undefined ? { cwd: stringArg(args, "workdir") } : {}),
			...(yieldTimeoutSeconds(args) !== undefined ? { timeout: yieldTimeoutSeconds(args) } : {}),
		}),
		fromResult: execCommandResult,
	},
	{
		name: "write_stdin",
		summary: "Poll a running exec session for output, or write to an interactive process.",
		target: "hub",
		call: writeStdinCall,
	},
	{
		name: "apply_patch",
		summary: "Apply a V4A patch to files (bridges to omp's edit tool in apply_patch mode).",
		target: "edit",
		toParams: args => ({ input: typeof args === "string" ? args : (stringArg(args, "input") ?? "") }),
		fromResult: result => resultText(result),
	},
	{
		name: "view_image",
		summary: "Attach a local image file to the conversation (bridges to omp's read tool).",
		target: "read",
		call: viewImageCall,
	},
	{
		name: "create_goal",
		summary: "Create a session goal with an objective and optional token budget.",
		target: "goal",
		toParams: args => ({
			op: "create",
			objective: stringArg(args, "objective") ?? "",
			...(numberArg(args, "token_budget") !== undefined ? { token_budget: numberArg(args, "token_budget") } : {}),
		}),
	},
	{
		name: "get_goal",
		summary: "Return the active session goal and its token usage.",
		target: "goal",
		toParams: () => ({ op: "get" }),
	},
	{
		name: "update_goal",
		summary: "Mark the active session goal complete.",
		target: "goal",
		toParams: updateGoalParams,
	},
];

const ALIAS_BY_NAME = new Map(CODEX_NESTED_ALIASES.map(alias => [alias.name, alias]));

/** Every vendor nested name this module can resolve (regardless of enablement). */
export function codexNestedAliasNames(): readonly string[] {
	return CODEX_NESTED_ALIASES.map(alias => alias.name);
}

/** Alias for `name` when the session's active model resolves to the codex profile. */
export function codexNestedAliasForModel(name: string, model: Model | undefined): CodexNestedAlias | undefined {
	if (!model || resolveHarnessProfile(model) !== "codex") return undefined;
	return ALIAS_BY_NAME.get(name);
}

/** Same enablement rule as the eval bridge's own tool lookup. */
export function codexNestedTargetEnabled(session: ToolSession, alias: CodexNestedAlias): boolean {
	const tool = session.getToolForEvalBridge
		? session.getToolForEvalBridge(alias.target)
		: session.getToolByName?.(alias.target);
	return tool !== undefined;
}

/**
 * `{name, description}` rows for every name the bridge resolves under the codex
 * profile — omp tools enabled for the bridge plus the aliases whose targets are
 * enabled. Feeds `ALL_TOOLS` and the `tools` proxy's enumeration traps.
 */
export function codexExecToolCatalog(session: ToolSession): { name: string; description: string }[] {
	const entries: { name: string; description: string }[] = [];
	for (const name of session.getEvalBridgeToolNames?.() ?? []) {
		const tool = session.getToolForEvalBridge ? session.getToolForEvalBridge(name) : session.getToolByName?.(name);
		const description = tool?.summary ?? tool?.description?.split("\n", 1)[0] ?? "";
		entries.push({ name, description });
	}
	for (const alias of CODEX_NESTED_ALIASES) {
		if (codexNestedTargetEnabled(session, alias)) {
			entries.push({ name: alias.name, description: alias.summary });
		}
	}
	return entries;
}

/**
 * The vendor capture's nested `### \`name\`` sections for `exec`, verbatim:
 * everything from the first `### ` to the end of the captured description,
 * trimmed so it splices cleanly between the fixed head and omp's own tool
 * sections. Undefined when no capture is loaded for the model.
 */
export function codexExecNestedDeclarations(model: Model | undefined): string | undefined {
	const exec = servedHarnessPrompt(model)?.tools["exec"];
	const description = exec?.description;
	if (typeof description !== "string") return undefined;
	const index = description.indexOf("\n### `");
	if (index === -1) return undefined;
	return `\n${description.slice(index + 1).trimEnd()}`;
}

/**
 * The summary paragraph of one nested `### \`name\`` section from the captured
 * exec description (text between the heading and the `exec tool declaration`
 * fence). Used to describe the matching omp tool under the codex profile.
 */
export function codexExecNestedSummary(model: Model | undefined, name: string): string | undefined {
	const declarations = codexExecNestedDeclarations(model);
	if (declarations === undefined) return undefined;
	const heading = `### \`${name}\``;
	const start = declarations.indexOf(heading);
	if (start === -1) return undefined;
	const body = declarations.slice(start + heading.length);
	const end = body.indexOf("exec tool declaration:");
	return (end === -1 ? body : body.slice(0, end)).trim() || undefined;
}
