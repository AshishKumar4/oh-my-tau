/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgHarnessMode = register({
	id: "harness.mode",
	type: "enum",
	values: ["auto", "native", "claude-code", "codex", "pi"] as const,
	default: "auto",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Harness Mode",
		description:
			"Which vendor harness surface the session emulates. Auto follows the active model; Native disables renames, facades, and vendor prompts; forcing a profile applies its surface to any model.",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "Follow the active model's catalog profile (current behavior)",
			},
			{
				value: "native",
				label: "Native",
				description: "Disable harness emulation: omp tool names, prompts, and wire format",
			},
			{
				value: "claude-code",
				label: "Claude Code",
				description: "Apply the Claude Code surface (renames, facades, prompt) to any model",
			},
			{
				value: "codex",
				label: "Codex",
				description: "Apply the Codex surface (renames, facades, prompt) to any model",
			},
			{
				value: "pi",
				label: "Pi",
				description: "Apply the pi surface (lowercase renames, bundled prompt) to any model",
			},
		],
	},
});
