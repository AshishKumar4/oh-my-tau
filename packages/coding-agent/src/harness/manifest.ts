import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";

export interface HarnessToolBinding {
	readonly wireName?: string;
}

const CLAUDE_CODE_BINDINGS: Readonly<Record<string, HarnessToolBinding>> = {
	bash: { wireName: "Bash" },
	read: { wireName: "Read" },
	write: { wireName: "Write" },
	edit: { wireName: "Edit" },
	task: { wireName: "Agent" },
	ask: { wireName: "AskUserQuestion" },
	web_search: { wireName: "WebSearch" },
	tool_search: { wireName: "ToolSearch" },
	monitor: { wireName: "Monitor" },
};

/**
 * Group name for the Codex multi-agent facades. The vendor's own name,
 * `collaboration`, is reserved server-side: functions declared there must match
 * the backend's schema byte for byte, and the backend then encrypts their
 * `message` argument for a server-side consumer, so an omp subagent would
 * receive ciphertext as its brief. Codex lets the group name be configured
 * (`features.multi_agent_v2.tool_namespace`); under any other name the same
 * functions are ordinary, and the model's brief arrives in plaintext.
 */
export const CODEX_COLLABORATION_NAMESPACE = "agents";

/**
 * Native tools keep their own names in the default `functions` namespace. The
 * `collaboration` namespace is reserved server-side for Codex's own multi-agent
 * functions, which the facades provide under those names.
 */
const CODEX_BINDINGS: Readonly<Record<string, HarnessToolBinding>> = {
	eval: { wireName: "exec" },
	ask: { wireName: "request_user_input" },
};

/**
 * pi's built-ins are all lowercase; omp's file-search tool answers to pi's
 * `find`. pi's `ls` and `powershell` have no omp equivalent and stay
 * unbound; every other omp tool that shares pi's vocabulary keeps its own
 * name, which an omitted binding already expresses — so the table lists
 * only the one true rename.
 */
const PI_BINDINGS: Readonly<Record<string, HarnessToolBinding>> = {
	glob: { wireName: "find" },
};

/**
 * Gemini CLI's built-ins under its own names. `list_directory` and `web_fetch`
 * are facades over `read` (see `facades.ts`); Gemini CLI's
 * `codebase_investigator` and `read_many_files` have no omp counterpart and
 * stay unbound.
 */
const GEMINI_CLI_BINDINGS: Readonly<Record<string, HarnessToolBinding>> = {
	// Same name, so nothing is renamed; the binding serves the vendor's declaration.
	glob: { wireName: "glob" },
	bash: { wireName: "run_shell_command" },
	read: { wireName: "read_file" },
	write: { wireName: "write_file" },
	edit: { wireName: "replace" },
	grep: { wireName: "search_file_content" },
	web_search: { wireName: "google_web_search" },
	todo: { wireName: "write_todos" },
	retain: { wireName: "save_memory" },
};

const MANIFESTS: Readonly<Record<HarnessProfile, Readonly<Record<string, HarnessToolBinding>>>> = {
	"claude-code": CLAUDE_CODE_BINDINGS,
	codex: CODEX_BINDINGS,
	pi: PI_BINDINGS,
	"gemini-cli": GEMINI_CLI_BINDINGS,
};

export function harnessToolBinding(
	profile: HarnessProfile | undefined,
	toolName: string,
): HarnessToolBinding | undefined {
	return profile === undefined ? undefined : MANIFESTS[profile][toolName];
}

function collectWireRenames(bindings: Readonly<Record<string, HarnessToolBinding>>): Readonly<Record<string, string>> {
	const renames: Record<string, string> = {};
	for (const [name, binding] of Object.entries(bindings)) {
		if (binding.wireName !== undefined) renames[name] = binding.wireName;
	}
	return renames;
}

const WIRE_RENAMES: Readonly<Record<HarnessProfile, Readonly<Record<string, string>>>> = {
	"claude-code": collectWireRenames(CLAUDE_CODE_BINDINGS),
	codex: collectWireRenames(CODEX_BINDINGS),
	pi: collectWireRenames(PI_BINDINGS),
	"gemini-cli": collectWireRenames(GEMINI_CLI_BINDINGS),
};

export function harnessWireRenames(profile: HarnessProfile): Readonly<Record<string, string>> {
	return WIRE_RENAMES[profile];
}

/**
 * Tools omp's own prompts name in their text, under their native names.
 * `deviceWrite` is the tool that takes omp's device URLs (`write agent://<id>`
 * to message, `write proc://<id>/kill` to stop): templates phrase messaging and
 * stopping that way only behind it, and a harness surface never carries it.
 */
const NATIVE_PROMPT_TOOL_REFS: Readonly<Record<string, string>> = {
	task: "task",
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	wait: "wait",
	deviceWrite: "write",
};

/** Whether omp's prompts name tools as `profile` presents them (see {@link harnessToolRefs}). */
export function harnessRefsFollowSurface(profile: HarnessProfile | undefined): profile is "claude-code" | "gemini-cli" {
	return profile === "claude-code" || profile === "gemini-cli";
}

/** The tools a harness profile presents, as {@link harnessToolRefs} reads them. */
export interface PresentedToolSurface {
	/** omp tools the model can reach, by native name. */
	readonly toolNames: readonly string[];
	/** Mounted facades: the wire name, the omp tool behind it, and whether it stands in for that tool. */
	readonly facades: readonly { readonly wireName: string; readonly target: string; readonly replacesTarget?: true }[];
}

/**
 * Tool names for omp's own prompt templates (`toolRefs`), keyed by native tool
 * name.
 *
 * `codex` and `pi` keep the literal names unconditionally, so native text
 * renders byte for byte as before. Under `claude-code` and `gemini-cli`, whose
 * core tools all answer to vendor names, the map is exactly the presented
 * `surface`: each reachable tool under its wire name,
 * each mounted facade under its own name, and a tool a facade stands in for
 * under the facade's (`wait` → `TaskOutput`). A key is absent when nothing on
 * the wire answers to it, so a template naming a tool through `toolRefs` can
 * leave the sentence out instead of naming a tool the model does not have.
 * The surface never carries `deviceWrite`: its agents message and stop through
 * the facades, not omp's device URLs.
 */
export function harnessToolRefs(
	profile: HarnessProfile | undefined,
	surface?: PresentedToolSurface,
): Readonly<Record<string, string>> {
	if (!harnessRefsFollowSurface(profile) || surface === undefined) return NATIVE_PROMPT_TOOL_REFS;
	const refs: Record<string, string> = {};
	for (const name of surface.toolNames) refs[name] = MANIFESTS[profile][name]?.wireName ?? name;
	for (const facade of surface.facades) {
		refs[facade.wireName] = facade.wireName;
		if (facade.replacesTarget) refs[facade.target] = facade.wireName;
	}
	return refs;
}
