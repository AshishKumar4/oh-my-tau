import type { AgentTool, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema, ToolNamespace } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import { applyToolProxy } from "../extensibility/tool-proxy";
import { nativeParams } from "./bridge";
import type { VendorTool } from "./capture";
import type { HarnessToolBinding } from "./manifest";

export interface HarnessFacadeHost {
	readonly settings: Settings;
}

/** Wire name a registry tool presents under a manifest binding: the binding's rename, else the tool's own claim. */
export function presentedWireName(tool: AgentTool, binding: HarnessToolBinding | undefined): string | undefined {
	return binding?.wireName ?? tool.customWireName;
}

/**
 * A registry tool as a harness profile presents it: the manifest's wire
 * identity as own properties over the tool's own surface. Own properties
 * matter — the agent loop spreads each tool into its request copy, which
 * keeps own keys only. Everything the binding leaves alone forwards to the
 * tool, so schema, description and argument handling stay live on the
 * instance.
 */
class PresentedTool implements AgentTool {
	declare readonly name: string;
	declare readonly label: string;
	declare readonly description: string;
	declare readonly parameters: TSchema;
	declare readonly execute: AgentTool["execute"];
	declare readonly customWireName?: string;
	declare readonly examples?: AgentTool["examples"];

	constructor(tool: AgentTool, binding: HarnessToolBinding | undefined, vendor: VendorSurface) {
		if (binding?.wireName !== undefined) this.customWireName = binding.wireName;
		// Tools are presented when they mount, before the capture has loaded, so
		// the vendor's declaration is read at request time rather than pinned
		// here. Its schema validates the call too: the bridge behind `execute`
		// already takes the vendor shape. omp's `examples` render into the wire
		// description, and the vendor client sends none.
		Object.defineProperty(this, "description", {
			enumerable: true,
			get: () => vendor()?.description ?? tool.description,
		});
		Object.defineProperty(this, "parameters", {
			enumerable: true,
			get: () => vendor()?.inputSchema ?? tool.parameters,
		});
		Object.defineProperty(this, "examples", {
			enumerable: true,
			get: () => (vendor() === undefined ? tool.examples : undefined),
		});
		applyToolProxy(tool, this);
	}
}

/** The vendor's declaration for the wire name a tool presents under, once a capture is served. */
export type VendorSurface = () => VendorTool | undefined;

/** `tool` as a profile presents it: the manifest's wire identity plus the vendor's description. */
export function presentTool(
	tool: AgentTool,
	binding: HarnessToolBinding | undefined,
	vendor: VendorSurface,
): AgentTool {
	return new PresentedTool(tool, binding, vendor);
}

export interface HarnessFacadeSpec<TWire extends TSchema = TSchema, TParams = unknown> {
	readonly target: string;
	readonly wireName: string;
	readonly replacesTarget?: true;
	readonly namespace?: ToolNamespace;
	readonly description: string;
	readonly parameters: TWire;
	readonly intent?: (args: Partial<Static<TWire>>) => string | undefined;
	toParams(args: Static<TWire>, host: HarnessFacadeHost): TParams;
}

function withPolicyKey(decision: ToolApprovalDecision | undefined, policyKey: string): ToolApprovalDecision {
	if (decision === undefined) return { tier: "exec", policyKey };
	if (typeof decision === "string") return { tier: decision, policyKey };
	return { policyKey, ...decision };
}

function mapPredicate<T>(
	value: T | ((args: never) => T) | undefined,
	toParams: (args: unknown) => unknown,
	fallback: T,
): T | ((args: unknown) => T) | undefined {
	if (typeof value !== "function") return value;
	const fn = value as (args: unknown) => T;
	return (args: unknown) => {
		try {
			return fn(toParams(args));
		} catch {
			return fallback;
		}
	};
}

export function harnessFacade(
	target: AgentTool,
	spec: HarnessFacadeSpec,
	host: HarnessFacadeHost,
	vendor: VendorSurface = () => undefined,
): AgentTool {
	const toParams = (args: unknown): unknown => nativeParams(spec.toParams(args as never, host) as object);
	const approval = target.approval;
	return {
		name: spec.wireName,
		persistAs: target.name,
		toNativeArgs: toParams,
		label: target.label,
		get description() {
			return vendor()?.description ?? spec.description;
		},
		get parameters() {
			return vendor()?.inputSchema ?? spec.parameters;
		},
		loadMode: "essential",
		...(spec.namespace ? { namespace: spec.namespace } : {}),
		...(spec.intent ? { intent: spec.intent as AgentTool["intent"] } : {}),
		approval: (args: unknown): ToolApprovalDecision => {
			try {
				return withPolicyKey(typeof approval === "function" ? approval(toParams(args)) : approval, target.name);
			} catch {
				return { tier: "exec", policyKey: target.name };
			}
		},
		...(target.formatApprovalDetails
			? {
					formatApprovalDetails: (args: unknown) => {
						try {
							return target.formatApprovalDetails?.(toParams(args));
						} catch {
							return undefined;
						}
					},
				}
			: {}),
		...(target.concurrency !== undefined
			? { concurrency: mapPredicate(target.concurrency, toParams, "exclusive") as AgentTool["concurrency"] }
			: {}),
		...(target.interruptible !== undefined
			? { interruptible: mapPredicate(target.interruptible, toParams, false) as AgentTool["interruptible"] }
			: {}),
		execute: (toolCallId, args, signal, onUpdate, context) =>
			target.execute(toolCallId, toParams(args) as never, signal, onUpdate, context),
	};
}
