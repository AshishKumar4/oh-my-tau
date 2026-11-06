import { type HarnessProfile, resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Tool, ToolCall, ToolChoice } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { buildHarnessToolNames, type HarnessToolNames } from "./transform-messages";

/** The provider API that declares, replays and decodes each profile's vendor names itself. */
const PROFILE_PROVIDER_API: Readonly<Record<HarnessProfile, Api | undefined>> = {
	"claude-code": "anthropic-messages",
	codex: "openai-codex-responses",
	pi: undefined,
};

export interface HarnessNameCodec {
	context: Context;
	options: SimpleStreamOptions;
	wrap(inner: AssistantMessageEventStream): AssistantMessageEventStream;
}

/**
 * A harness profile on a provider that does not speak it, as when a profile is
 * forced onto any model: the request declares, replays and forces tools by the
 * profile's vendor names, and the response's calls come back under the omp
 * names, as the profile's own provider does. The identity when that provider
 * serves the request or no tool is renamed; a renamed context passes again
 * unchanged, since its tools carry their vendor names.
 */
export function applyHarnessNameCodec(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
): HarnessNameCodec {
	const identity: HarnessNameCodec = { context, options, wrap: inner => inner };
	const tools = [...(context.tools ?? []), ...(context.inactiveTools ?? [])];
	if (!tools.some(tool => tool.customWireName !== undefined && tool.customWireName !== tool.name)) return identity;
	const override = options.harnessProfile;
	const profile = override === undefined ? resolveHarnessProfile(model) : (override ?? undefined);
	if (profile === undefined || PROFILE_PROVIDER_API[profile] === model.api) return identity;
	const names = buildHarnessToolNames(model, profile, tools, override);
	if (!names) return identity;
	return {
		context: encodeContext(context, names),
		options: { ...options, toolChoice: encodeToolChoice(options.toolChoice, names) },
		wrap: inner => decodeStream(inner, names),
	};
}

function encodeContext(context: Context, names: HarnessToolNames): Context {
	const encodeTool = (tool: Tool): Tool => {
		const wireName = names.toWire.get(tool.name);
		return wireName === undefined ? tool : { ...tool, name: wireName };
	};
	return {
		...context,
		tools: context.tools?.map(encodeTool),
		...(context.inactiveTools && { inactiveTools: context.inactiveTools.map(encodeTool) }),
		messages: context.messages.map(message => {
			if (message.role === "toolResult") {
				const wireName = names.toWire.get(message.toolName);
				return wireName === undefined ? message : { ...message, toolName: wireName };
			}
			if (message.role !== "assistant") return message;
			// A facade call keeps its vendor `wireName`; its omp `name` replays once the facade is gone.
			const content = message.content.map(block => {
				if (block.type !== "toolCall") return block;
				const wireName = names.toWire.get(block.name);
				return wireName === undefined ? block : { ...block, name: wireName };
			});
			return content.some((block, index) => block !== message.content[index]) ? { ...message, content } : message;
		}),
	};
}

function encodeToolChoice(choice: ToolChoice | undefined, names: HarnessToolNames): ToolChoice | undefined {
	if (typeof choice !== "object") return choice;
	if ("function" in choice) {
		const wireName = names.toWire.get(choice.function.name);
		return wireName === undefined ? choice : { ...choice, function: { name: wireName } };
	}
	if (!("name" in choice)) return choice;
	const wireName = names.toWire.get(choice.name);
	return wireName === undefined ? choice : { ...choice, name: wireName };
}

/**
 * Calls under their omp names. Events share blocks, and a stage that projects
 * the provider's blocks copies the wire name back on each event, so a block is
 * decoded whenever its name is not the one it was given.
 */
function decodeStream(inner: AssistantMessageEventStream, names: HarnessToolNames): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	const decodedNames = new WeakMap<ToolCall, string>();
	const decodeCall = (block: ToolCall): void => {
		if (decodedNames.get(block) === block.name) return;
		block.name = names.fromWire.get(block.name) ?? block.name;
		decodedNames.set(block, block.name);
	};
	const decode = (message: AssistantMessage): void => {
		for (const block of message.content) if (block.type === "toolCall") decodeCall(block);
	};
	void (async () => {
		try {
			for await (const event of inner) {
				if ("partial" in event) decode(event.partial);
				if (event.type === "toolcall_end") decodeCall(event.toolCall);
				if (event.type === "done") decode(event.message);
				if (event.type === "error") decode(event.error);
				out.push(event);
			}
			if (!out.done) {
				const result = await inner.result();
				decode(result);
				out.end(result);
			}
		} catch (error) {
			if (!out.done) out.fail(error);
		}
	})();
	return out;
}
