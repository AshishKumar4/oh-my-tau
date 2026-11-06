import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	computeNonMessageBreakdown,
	estimateToolSchemaTokens,
	getToolSchemaMetadataRevision,
	invalidateToolSchemaMetadata,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

const tokenizer = new Tokenizer();

/** External arktype copies expose bind on callable schemas, unlike omptype. */
function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

describe("extension tool context accounting", () => {
	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Binding the schema loses its wire surface and once poisoned token accounting.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
	});
});

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters } as never],
			tokenizer,
		);
		const wireEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never],
			tokenizer,
		);
		expect(arktypeEstimate).toBe(wireEstimate);
	});

	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Regression (PR #9185): applyToolProxy bound every callable property,
		// and an external-arktype Type HAS Function.prototype.bind (unlike
		// omptype), so the bound `parameters` lost its schema surface,
		// toolWireSchema returned the bare function, and the undefined
		// JSON.stringify poisoned token accounting — crashing every read-only
		// subagent at first prompt. The proxied schema must keep counting as
		// its wire JSON Schema, identical to the pre-converted equivalent.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		// The proxied tool must keep counting exactly like the unwrapped tool:
		// old code fed `undefined` into the tokenizer here and crashed.
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		// The crash frame was computeNonMessageBreakdown → estimateToolSchemaTokens
		// inside pre-prompt compaction; exercise that whole path, memo included.
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
	});

	it("skips a parameters value that stringifies to undefined, counting exactly name + description", () => {
		// A plain function is neither an arktype schema nor JSON-serializable:
		// the independent unserializable-schema fallback must skip it while the
		// tool's own strings still contribute their exact token share.
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: "odd tool", parameters: function bareSchema() {} } as never],
			tokenizer,
		);
		expect(estimate).toBe(estimateToolSchemaTokens([{ name: "odd", description: "odd tool" } as never], tokenizer));
	});

	it("skips non-string name/description fragments", () => {
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: undefined, parameters: { type: "object" } } as never],
			tokenizer,
		);
		expect(estimate).toBeGreaterThan(0);
	});

	it("does not reread dynamic metadata until its explicit revision changes", () => {
		let description = "short";
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return description;
			},
			parameters: {},
		};
		const tools = [tool];
		const first = estimateToolSchemaTokens(tools, tokenizer);
		expect(reads).toBe(1);
		expect(estimateToolSchemaTokens(tools, tokenizer)).toBe(first);
		expect(reads).toBe(1);

		description = "a substantially longer dynamic description after a live policy update";
		invalidateToolSchemaMetadata(tools);
		expect(getToolSchemaMetadataRevision(tools)).toBe(1);
		expect(estimateToolSchemaTokens(tools, tokenizer)).toBeGreaterThan(first);
		expect(reads).toBe(2);
	});

	it("separates array, tokenizer, and source-revision cache keys", () => {
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return "metadata";
			},
			parameters: {},
		};
		const tools = [tool];
		estimateToolSchemaTokens(tools, tokenizer, 1);
		estimateToolSchemaTokens(tools, tokenizer, 1);
		expect(reads).toBe(1);

		estimateToolSchemaTokens(tools, tokenizer, 2);
		expect(reads).toBe(2);
		estimateToolSchemaTokens([...tools], tokenizer, 2);
		expect(reads).toBe(3);
		estimateToolSchemaTokens(tools, new Tokenizer(), 2);
		expect(reads).toBe(4);
	});
});
