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

const MANIFESTS: Readonly<Record<HarnessProfile, Readonly<Record<string, HarnessToolBinding>>>> = {
	"claude-code": CLAUDE_CODE_BINDINGS,
	codex: CODEX_BINDINGS,
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
};

export function harnessWireRenames(profile: HarnessProfile): Readonly<Record<string, string>> {
	return WIRE_RENAMES[profile];
}
