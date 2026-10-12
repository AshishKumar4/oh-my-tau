/**
 * `omp auth keys <add|list|remove> <provider> [id]` — manage pooled API keys.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { AUTH_KEYS_ACTIONS, runAuthKeysCommand } from "../cli/auth-keys-cli";
import { authHelp as commandHelp } from "../cli/command-help";

export default class Auth extends Command {
	static description = commandHelp.description;
	static args = {
		group: Args.string({ description: "Credential group", required: true, options: ["keys"] }),
		action: Args.string({ description: "Action", required: true, options: [...AUTH_KEYS_ACTIONS] }),
		provider: Args.string({ description: "Provider id (e.g. anthropic)", required: true }),
		id: Args.string({ description: "Stored key id (remove)", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		workspace: Flags.string({
			description: "Anthropic workspace ID for a key not scoped to one (add; asked for when omitted)",
		}),
	};

	static examples = [
		`# Add a key to the anthropic pool (hidden prompt; or pipe it on stdin)\n  ${APP_NAME} auth keys add anthropic`,
		`# Add a key that is not scoped to a workspace, naming the workspace its requests use\n  ${APP_NAME} auth keys add anthropic --workspace wrkspc_01Jw…`,
		`# List pooled keys (masked) and the serving order\n  ${APP_NAME} auth keys list anthropic`,
		`# Remove a pooled key by its id\n  ${APP_NAME} auth keys remove anthropic 12`,
		`# Serve pooled API keys before subscriptions\n  ${APP_NAME} config set auth.poolOrder '{"anthropic":"api-keys-first"}'`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Auth);
		const action = AUTH_KEYS_ACTIONS.find(candidate => candidate === args.action);
		if (!action) throw new Error(`Unknown action '${args.action}'`);
		if (!args.provider) throw new Error(`Usage: ${APP_NAME} auth keys ${action} <provider>`);
		let id: number | undefined;
		if (args.id !== undefined) {
			id = Number(args.id);
			if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid key id '${args.id}'`);
		}
		await runAuthKeysCommand({ action, provider: args.provider, id, workspace: flags.workspace, json: flags.json });
	}
}
