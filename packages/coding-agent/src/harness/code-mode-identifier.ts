/**
 * Vendor rules for the names a Code Mode isolate exposes on its `tools`
 * global. Ported from codex-rs `code-mode-protocol/src/description.rs`
 * (Apache-2.0): `normalize_code_mode_identifier` at :346 and the
 * `<namespace>__<tool>` spelling `code_mode_name_for_tool_name` produces for a
 * grouped tool.
 *
 * A model post-trained on Codex types the *normalized* spelling, so any name
 * omp renders here has to be the name omp's bridge answers to; otherwise the
 * call fails inside the isolate as an undefined function, with nothing on the
 * wire to show for it. `test/harness-identifier-parity.test.ts` fences that.
 */

const IDENTIFIER_START = /[A-Za-z]/;
const IDENTIFIER_PART = /[A-Za-z0-9]/;

export function normalizeCodeModeIdentifier(toolKey: string): string {
	let identifier = "";
	for (const [index, character] of [...toolKey].entries()) {
		const valid =
			character === "_" ||
			character === "$" ||
			(index === 0 ? IDENTIFIER_START.test(character) : IDENTIFIER_PART.test(character));
		identifier += valid ? character : "_";
	}
	return identifier.length === 0 ? "_" : identifier;
}

export function codeModeIdentifier(toolName: string): string {
	return normalizeCodeModeIdentifier(toolName);
}
