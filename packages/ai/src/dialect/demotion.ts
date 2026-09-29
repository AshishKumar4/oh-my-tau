import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { getDialectDefinition } from "./factory";

/**
 * Whether prior-turn reasoning the target cannot replay natively is dropped
 * instead of demoted to text: true for every Anthropic-dialect (Claude) target,
 * on any provider — Anthropic, Bedrock, Vertex, Copilot, gateways, and
 * OpenAI-compatible proxies alike.
 *
 * Anthropic's `reasoning_extraction` classifier refuses requests that re-send
 * prior reasoning to Claude as conversation content ("blocked as it seems to
 * violate Anthropic's Terms of Service restrictions on reverse engineering or
 * duplicating model outputs"). Wrapping it in `<thinking>` / `antml:thinking`
 * tags trips the classifier outright; bare prose only lowers the per-block
 * signal, and heat is cumulative (block count and early-conversation position
 * raise it), so long multi-model histories are refused anyway. Claude therefore
 * receives prior reasoning only as a native thinking block it accepts: signed,
 * or its own unsigned output on an endpoint that replays unsigned thinking
 * natively. Every other kind — another model's or provider's reasoning,
 * unsigned blocks, stale or stripped signatures, unsigned blocks after the
 * signing-proxy auto-demote — is dropped. Visible text and tool calls replay
 * unchanged, so the request stays deterministic for prompt caching.
 */
export function dropsUnreplayableThinking(modelId: string): boolean {
	return preferredDialect(modelId) === "anthropic";
}

/**
 * Wrap a prior-turn reasoning string for demotion into native conversation
 * history — the cross-provider / cross-model case where the target cannot
 * replay it as a structured thinking block (verified end-to-end against Gemini
 * 3: a replayed unsigned `thought` part is schema-accepted but silently
 * discarded — neither recalled nor influencing generation). The reasoning is
 * wrapped in the target's canonical thinking form so it reads as reasoning
 * rather than prose the model might mimic.
 *
 * Returns `""` — emit nothing — for empty reasoning and for every target that
 * {@link dropsUnreplayableThinking} (Claude). Callers MUST skip an empty result
 * rather than send an empty text block.
 *
 * Harmony and Gemma are the dialect exceptions: their `renderThinking` emits
 * chat-template control tokens (`<|channel|>analysis`, `<|channel>thought`)
 * that must not appear inside a structured native message, so they fall back
 * to a plain `<think>` block. Every other dialect's thinking form is
 * inline-safe XML tags or a markdown fence, so a non-empty result always ends
 * with its closing delimiter, never with whitespace from the reasoning.
 *
 * The result does not append a delimiter; callers that flatten adjacent blocks
 * into a single string must insert their own separator.
 *
 * Distinct from {@link DialectDefinition.renderThinking}, which targets the
 * owned-dialect *text transport* where those control tokens are legal.
 */
export function renderDemotedThinking(modelId: string, text: string): string {
	if (!text || dropsUnreplayableThinking(modelId)) return "";
	text = text.toWellFormed();
	const dialect = preferredDialect(modelId);
	if (dialect === "harmony" || dialect === "gemma") return `<think>\n${text}\n</think>`;
	return getDialectDefinition(dialect).renderThinking(text);
}
