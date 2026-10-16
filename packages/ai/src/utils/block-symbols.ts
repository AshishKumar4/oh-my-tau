import type { Message } from "../types";

/** Stores streamed tool-call argument JSON for live renderers and parser recovery. */
export const kStreamingPartialJson = Symbol("provider.block.partialJson");

/** Carries streamed tool-call argument JSON without exposing a string-keyed property. */
export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

/** Reads streamed tool-call argument JSON from a block or event snapshot. */
export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

/** Writes streamed tool-call argument JSON to a block or clears it with `undefined`. */
export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

/** Clears streamed tool-call argument JSON without deleting or changing object shape. */
export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}

/** Stores a provider-local stream block index without exposing a string-keyed property. */
export const kStreamingBlockIndex = Symbol("provider.block.index");

/** Stores the last parsed argument prefix length for throttled streaming JSON parsing. */
export const kStreamingLastParseLen = Symbol("provider.block.lastParseLen");

/**
 * The Cursor interaction envelope's `call_id` for a streamed tool-call block.
 *
 * Tracked separately from the block's own `id` because they are NOT the same
 * key: MCP and Pi blocks are filed under the id inside the call's `args`, which
 * is what the exec channel pairs its result under, while every streamed
 * `ToolCall*Update` correlates on the envelope's `call_id`. Matching
 * completions against the block id would mis-route every call whose args carry
 * their own id.
 */
export const kStreamingEnvelopeId = Symbol("provider.block.envelopeId");

/** Marks streamed tool-call arguments that already received an authoritative done payload. */
export const kStreamingArgumentsDone = Symbol("provider.block.argumentsDone");

/** Exact output-array slot established by the provider's stream-item router. Never persisted as model input. */
export const kResponsesReplayItem = Symbol("provider.block.responsesReplayItem");
export interface ResponsesReplayItemLocator {
	readonly index: number;
	readonly type: "function_call" | "custom_tool_call" | "computer_call";
	readonly callId: string;
	readonly itemId?: string;
}
export type ResponsesReplayItemCarrier = object & { [kResponsesReplayItem]?: ResponsesReplayItemLocator };

export function bindResponsesReplayItem(block: ResponsesReplayItemCarrier, index: number, item: object): void {
	if (!("type" in item) || !("call_id" in item) || typeof item.call_id !== "string") return;
	if (item.type !== "function_call" && item.type !== "custom_tool_call" && item.type !== "computer_call") return;
	block[kResponsesReplayItem] = {
		index,
		type: item.type,
		callId: item.call_id,
		itemId: "id" in item && typeof item.id === "string" ? item.id : undefined,
	};
}

/** Classifies Cursor's in-flight tool-call kind without leaking provider-private state. */
export const kStreamingBlockKind = Symbol("provider.block.kind");

/**
 * Marks a `toolCall` content block that Cursor's exec channel already
 * executed server-side (via the coding-agent bridge) and whose result is
 * buffered separately for emission via the assistant-loop stream.
 *
 * `agent-loop.ts` MUST skip execution of blocks carrying this marker —
 * treating them as a fresh runnable tool call would run the same
 * side-effecting tool (bash, write, delete, …) a second time. Symbol-keyed
 * so it never persists across the JSONL round-trip, where rebuild instead
 * pairs the block with its already-persisted `toolResult` message by id.
 */
export const kCursorExecResolved = Symbol("provider.block.cursorExecResolved");

/** Carries the resolved marker without exposing a string-keyed property. */
export type CursorExecResolvedCarrier = object & { [kCursorExecResolved]?: true };

/** True when a toolCall block was already executed by Cursor's exec channel. */
export function isCursorExecResolved(block: CursorExecResolvedCarrier | null | undefined): boolean {
	return block?.[kCursorExecResolved] === true;
}

/**
 * Copy {@link kCursorExecResolved} onto a cloned/projected toolCall block.
 *
 * Stream projectors (owned/in-band dialect, leaked-thinking heal) rebuild
 * toolCall objects field-by-field. Dropping this marker lets `agent-loop.ts`
 * re-execute a call Cursor already settled — duplicate toolResults and a
 * second bash/write/delete. Partial-JSON is already copied explicitly; this
 * marker is the other load-bearing symbol that must survive the same way.
 */
export function copyCursorExecResolved(target: CursorExecResolvedCarrier, source: CursorExecResolvedCarrier): void {
	if (source[kCursorExecResolved] === true) target[kCursorExecResolved] = true;
}

/**
 * Marks a text block synthesized by cross-model thinking demotion in
 * `transformMessages`. Converters that flatten adjacent text blocks into one
 * string (openai-completions) insert a paragraph separator after marked
 * blocks; unmarked adjacent blocks keep their original byte sequence.
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kDemotedThinking = Symbol("provider.block.demotedThinking");

/** Carries the demoted-thinking marker without exposing a string-keyed property. */
export type DemotedThinkingCarrier = object & { [kDemotedThinking]?: boolean };

/** True for text blocks synthesized by cross-model thinking demotion. */
export function isDemotedThinking(block: DemotedThinkingCarrier | null | undefined): boolean {
	return block?.[kDemotedThinking] === true;
}

/**
 * Marks a thinking block that `transformMessages` carried natively from
 * another host serving the same model (see `compat/reasoning-carry` in the
 * catalog). Its host-bound signature and item id are gone, so encoders that
 * replay reasoning from stored payloads (Responses) emit a plaintext item for
 * it instead. Symbol-keyed so the marker never persists or reaches the wire.
 */
export const kCarriedReasoning = Symbol("provider.block.carriedReasoning");

/** Carries the carried-reasoning marker without exposing a string-keyed property. */
export type CarriedReasoningCarrier = object & { [kCarriedReasoning]?: boolean };

/** True for thinking blocks carried natively from another host of the same model. */
export function isCarriedReasoning(block: CarriedReasoningCarrier | null | undefined): boolean {
	return block?.[kCarriedReasoning] === true;
}

/**
 * Marks an Anthropic wire message that was serialized from a source
 * `role: "user"` message.
 *
 * The wire role alone cannot answer this. `convertAnthropicMessages` emits
 * `role: "user"` for several things that are not a conversational turn:
 * `developer` messages on models without mid-conversation `system` support,
 * `tool_result` runs, and the synthetic `Continue.` pads inserted between
 * adjacent assistants. Prompt-cache decimation counts conversational turns,
 * so it reads this marker instead of guessing from wire content.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kConversationalUser = Symbol("provider.message.conversationalUser");

/** Carries the conversational-user marker without exposing a string-keyed property. */
export type ConversationalUserCarrier = object & { [kConversationalUser]?: boolean };

/** True for wire messages serialized from a source `role: "user"` message. */
export function isConversationalUser(message: ConversationalUserCarrier | null | undefined): boolean {
	return message?.[kConversationalUser] === true;
}

/**
 * Marks a `role: "user"` message that `transformMessages` synthesized rather
 * than one the user sent.
 *
 * The stale-tool-result note is deliberately emitted as `user` so no provider
 * elevates untrusted tool output to instruction priority, which leaves it
 * indistinguishable from a real turn by role alone. Prompt-cache decimation
 * must not count it, or an orphan result appearing or disappearing in a
 * compacted history shifts every later checkpoint.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kSyntheticUser = Symbol("provider.message.syntheticUser");

/** Carries the synthetic-user marker without exposing a string-keyed property. */
export type SyntheticUserCarrier = object & { [kSyntheticUser]?: boolean };

/** True for `user` messages synthesized by message transformation. */
export function isSyntheticUser(message: SyntheticUserCarrier | null | undefined): boolean {
	return message?.[kSyntheticUser] === true;
}

/**
 * Marks a message synthesized by a per-call context transform rather than
 * loaded from persisted conversation history.
 *
 * Prompt-cache boundaries must skip these messages: their content is rebuilt
 * for each request and cannot anchor a prefix reused by the next turn.
 * Symbol-keyed so the marker never persists or reaches the provider wire.
 */
export const kPerCallContextMessage = Symbol("agent.message.perCallContext");

/**
 * How a per-call message came to be: `added` has no place in the history, `rewritten`
 * replaces the history message at its position, and `untraced` could be either: the
 * transform restructured the history past tracing.
 */
export type PerCallContextOrigin = "added" | "rewritten" | "untraced";

/** Carries per-call context provenance without exposing a string-keyed property. */
export type PerCallContextMessageCarrier = object & { [kPerCallContextMessage]?: PerCallContextOrigin };

/** Marks a message as synthesized for the current provider call. */
export function markPerCallContextMessage(message: PerCallContextMessageCarrier, origin: PerCallContextOrigin): void {
	message[kPerCallContextMessage] = origin;
}

/** Copies per-call context provenance to a converted or projected message. */
export function copyPerCallContextMessage(
	target: PerCallContextMessageCarrier,
	source: PerCallContextMessageCarrier,
): void {
	const origin = source[kPerCallContextMessage];
	if (origin !== undefined) target[kPerCallContextMessage] = origin;
}

/** True when a message was synthesized for the current provider call. */
export function isPerCallContextMessage(message: PerCallContextMessageCarrier | null | undefined): boolean {
	return message?.[kPerCallContextMessage] !== undefined;
}

/** True when a context transform added the message for the current call: it is not part of the history. */
export function isAddedContextMessage(message: PerCallContextMessageCarrier | null | undefined): boolean {
	return message?.[kPerCallContextMessage] === "added";
}

/**
 * Original history position carried by a context message clone.
 *
 * Object-spread transforms retain this symbol, allowing the extension runner
 * to distinguish byte-identical historical copies from inserted messages.
 */
export const kContextHistoryIndex = Symbol("agent.message.contextHistoryIndex");

/** Carries a context message's original history position. */
export type ContextHistoryIndexCarrier = object & { [kContextHistoryIndex]?: number };

/** Reads a context message's original history position. */
export function getContextHistoryIndex(message: ContextHistoryIndexCarrier | null | undefined): number | undefined {
	return message?.[kContextHistoryIndex];
}

/** Records a context message's original history position. */
export function setContextHistoryIndex(message: ContextHistoryIndexCarrier, index: number): void {
	message[kContextHistoryIndex] = index;
}

/** Removes context-history tracking before provider conversion. */
export function clearContextHistoryIndex(message: ContextHistoryIndexCarrier): void {
	delete message[kContextHistoryIndex];
}

/**
 * History position of a message a context transform kept from its history, set by
 * the extension runner on every message it hands back (absent on added ones). A
 * native compaction cut uses it to tell the summarized history from the turns kept
 * after it. Object spread retains it.
 */
export const kContextHistoryPosition = Symbol("agent.message.contextHistoryPosition");

/** Carries the history position a context transform kept a message from. */
export type ContextHistoryPositionCarrier = object & { [kContextHistoryPosition]?: number };

/** Reads the history position a context transform kept a message from. */
export function getContextHistoryPosition(
	message: ContextHistoryPositionCarrier | null | undefined,
): number | undefined {
	return message?.[kContextHistoryPosition];
}

/** Records the history position a context transform kept a message from, or removes it. */
export function setContextHistoryPosition(message: ContextHistoryPositionCarrier, position: number | undefined): void {
	if (position === undefined) delete message[kContextHistoryPosition];
	else message[kContextHistoryPosition] = position;
}

/**
 * The message a per-call copy stands for. A message converted once and handed to
 * each call as a provenance copy keeps one identity whatever position or origin a
 * call gives it, so state kept per message across requests (the date/cwd reminder
 * a turn went out with) survives a position change. Object spread retains it.
 */
export const kContextIdentity = Symbol("agent.message.contextIdentity");

/** Carries the message a per-call copy stands for. */
export type ContextIdentityCarrier = object & { [kContextIdentity]?: object };

/** The message `message` stands for across calls: itself unless it is a per-call copy. */
export function contextIdentity(message: ContextIdentityCarrier): object {
	return message[kContextIdentity] ?? message;
}

/** Marks `copy`, a per-call rewrite of `source`, as standing for the message `source` stands for. */
export function inheritContextIdentity<T extends object>(copy: T, source: ContextIdentityCarrier): T {
	const carrier: ContextIdentityCarrier = copy;
	carrier[kContextIdentity] = contextIdentity(source);
	return copy;
}

/** Provenance copies of each converted message, by the origin and history position they carry. */
const provenanceCopies = new WeakMap<Message, Map<string, Message>>();

/**
 * `message`, converted from `source`, as this call sends it. Conversions cached by
 * identity are shared across calls, but a context transform's provenance (origin and
 * history position) belongs to one call: a source carrying it gets a copy with its
 * current values, so no later call can change what this call read. A copy is never
 * changed once made, so calls with the same provenance share it, and caches keyed by
 * message identity hold across them; every copy of `message` has its
 * {@link contextIdentity}.
 */
export function withContextProvenance(
	message: Message,
	source: PerCallContextMessageCarrier & ContextHistoryPositionCarrier,
): Message {
	const origin = source[kPerCallContextMessage];
	const position = source[kContextHistoryPosition];
	if (origin === undefined && position === undefined) return message;
	let copies = provenanceCopies.get(message);
	const key = `${origin ?? ""}:${position ?? ""}`;
	const shared = copies?.get(key);
	if (shared) return shared;
	const copy = { ...message };
	const carrier: PerCallContextMessageCarrier & ContextHistoryPositionCarrier = copy;
	if (origin === undefined) delete carrier[kPerCallContextMessage];
	else carrier[kPerCallContextMessage] = origin;
	setContextHistoryPosition(carrier, position);
	inheritContextIdentity(copy, message);
	if (!copies) {
		copies = new Map();
		provenanceCopies.set(message, copies);
	}
	copies.set(key, copy);
	return copy;
}

/**
 * Re-applies the symbol-keyed metadata that `structuredClone` cannot carry.
 *
 * Every marker in this module rides on a message or content block as a symbol
 * property, and `structuredClone` drops symbols outright. A cloned message
 * therefore compares unequal to its source under `Bun.deepEquals` even when the
 * outbound bytes are identical — which made per-call change detection report
 * every freshly streamed assistant message as rewritten, truncating the
 * Anthropic cacheable prefix at the last user turn for the rest of the turn.
 *
 * Own symbols are enumerated rather than listed so a new marker cannot silently
 * fall out of the clone. Content blocks are restored positionally: the clone is
 * structurally identical, so indices align.
 */
export function restoreClonedMessageMetadata(target: object, source: object): void {
	copyOwnSymbols(target, source);
	const targetContent = (target as { content?: unknown }).content;
	const sourceContent = (source as { content?: unknown }).content;
	if (!Array.isArray(targetContent) || !Array.isArray(sourceContent)) return;
	const shared = Math.min(targetContent.length, sourceContent.length);
	for (let index = 0; index < shared; index++) {
		const targetBlock = targetContent[index];
		const sourceBlock = sourceContent[index];
		if (
			targetBlock !== null &&
			typeof targetBlock === "object" &&
			sourceBlock !== null &&
			typeof sourceBlock === "object"
		) {
			copyOwnSymbols(targetBlock, sourceBlock);
		}
	}
}

function copyOwnSymbols(target: object, source: object): void {
	for (const symbol of Object.getOwnPropertySymbols(source)) {
		(target as Record<symbol, unknown>)[symbol] = (source as Record<symbol, unknown>)[symbol];
	}
}
