/**
 * Claude Code inference-fingerprint constants, kept in a leaf module so consumers
 * outside the provider (`registry/oauth/anthropic`, `usage/claude`) don't
 * import the heavy `providers/anthropic` module.
 *
 * That import edge was a live init cycle: `providers/anthropic` → `stream` →
 * `registry` → `registry/oauth/anthropic` → back into the still-initializing
 * provider module.
 */

/**
 * Pinned Claude Code CLI version: the offline fallback for {@link getClaudeCodeVersion}.
 * Bumped to the latest npm release by `bun run check-spoofed-versions --update`.
 */
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280";
/** `@anthropic-ai/sdk` version bundled by the current Claude Code release. */
export const claudeCodeSdkVersion = "0.112.1";

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
// A capture's `clientVersion` is the billing header's `cc_version` verbatim:
// the CLI version, then the fingerprint of the recording's first prompt.
const CAPTURE_CLIENT_VERSION_PATTERN = /^(\d+\.\d+\.\d+)(?:\.[0-9a-f]{3})?$/;
const VERSION_TOO_OLD_CODE = "claude_code_version_too_old";
const REQUIRED_VERSION_PATTERN = /version (\d+\.\d+\.\d+) or newer is required/i;

let adoptedClaudeCodeVersion: string | null = null;

/**
 * CLI version a Claude Code harness capture was recorded from. The capture
 * stores `cc_version` (`2.1.284.b93`); its three-hex suffix fingerprints the
 * recording's own first prompt, so only the version carries over to another
 * conversation. Undefined for anything that is not a Claude Code version
 * (`bundled`, blank).
 */
export function claudeCodeCaptureVersion(clientVersion: string | undefined): string | undefined {
	if (clientVersion === undefined) return undefined;
	return CAPTURE_CLIENT_VERSION_PATTERN.exec(clientVersion.trim())?.[1];
}

/**
 * Claude Code CLI version represented on the Anthropic wire (User-Agent, billing
 * header): `PI_AI_CLAUDE_CODE_VERSION` → version adopted from a server rejection
 * (see {@link adoptRequiredClaudeCodeVersion}) → {@link DEFAULT_CLAUDE_CODE_VERSION}.
 *
 * `servedClientVersion` is the `clientVersion` of the claude-code harness
 * capture whose prompt and tools the request carries. It takes the default's
 * place, so the header names the release the served text came from. The
 * adopted version is the minimum the server demanded: it still replaces an
 * older capture version but never downgrades a newer one. The env pin wins
 * over both.
 */
export function getClaudeCodeVersion(servedClientVersion?: string): string {
	const pinned = process.env.PI_AI_CLAUDE_CODE_VERSION;
	if (pinned) return pinned;
	const served = claudeCodeCaptureVersion(servedClientVersion);
	if (served === undefined) return adoptedClaudeCodeVersion || DEFAULT_CLAUDE_CODE_VERSION;
	return adoptedClaudeCodeVersion && compareSemver(adoptedClaudeCodeVersion, served) > 0
		? adoptedClaudeCodeVersion
		: served;
}

/** User-Agent emitted by Claude Code's CLI inference entrypoint. */
export function getClaudeCodeUserAgent(servedClientVersion?: string): string {
	return `claude-cli/${getClaudeCodeVersion(servedClientVersion)} (external, cli)`;
}

/** Entrypoint Claude Code's CLI reports in the billing header. */
export const claudeCodeEntrypoint = "cli";

/**
 * Billing-header prefix. Exported here rather than from `providers/anthropic` so
 * the harness capture/record path (`coding-agent/src/harness/*`) can parse it
 * without importing the provider module.
 */
export const claudeCodeBillingHeaderPrefix = "x-anthropic-billing-header:";

function compareSemver(a: string, b: string): number {
	const pa = SEMVER_PATTERN.exec(a);
	const pb = SEMVER_PATTERN.exec(b);
	if (!pa || !pb) return 0;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(pa[i]) - Number(pb[i]);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Adopts the minimum version named by an Anthropic `claude_code_version_too_old`
 * rejection for the rest of the process, so the pinned fallback going stale costs
 * one rejected request instead of a hard failure.
 *
 * Returns true only when the wire version actually increased — callers retry on
 * true, so a repeated rejection at the same version cannot loop. Always false
 * while `PI_AI_CLAUDE_CODE_VERSION` pins the version explicitly.
 * `servedClientVersion` is the one the rejected request resolved its version
 * with (see {@link getClaudeCodeVersion}), so the comparison is against the
 * version it actually sent.
 */
export function adoptRequiredClaudeCodeVersion(error: unknown, servedClientVersion?: string): boolean {
	if (process.env.PI_AI_CLAUDE_CODE_VERSION) return false;
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes(VERSION_TOO_OLD_CODE)) return false;
	const required = REQUIRED_VERSION_PATTERN.exec(message)?.[1];
	if (!required || compareSemver(required, getClaudeCodeVersion(servedClientVersion)) <= 0) return false;
	adoptedClaudeCodeVersion = required;
	return true;
}

/** Test seam: forgets the version {@link adoptRequiredClaudeCodeVersion} adopted. */
export function resetAdoptedClaudeCodeVersion(): void {
	adoptedClaudeCodeVersion = null;
}

/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */
export const claudeToolPrefix: string = "_";
/** Identity block prepended by Claude Code's CLI runtime. */
export const claudeCodeSystemInstruction = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Opens the per-spawn part of a subagent's system prompt (assignment context,
 * worktree, peer roster): text that differs between siblings spawned from one
 * agent definition. Under the claude-code profile the Anthropic transport
 * anchors the head cache breakpoint on the text before it, so siblings share
 * the vendor prompt, footer and project context as one cached prefix. The
 * transport removes the marker, with one directly following newline, from the
 * wire in every profile; no other transport knows it.
 */
export const SUBAGENT_VOLATILE_MARKER = "<!-- omp:volatile-subagent -->";
