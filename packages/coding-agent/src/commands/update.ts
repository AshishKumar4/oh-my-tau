/**
 * Say how to update this build, or update installed plugins.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

/**
 * oh-my-tau rebuilds from its source checkout. Upstream's release channels (the
 * build service, npm, Homebrew, mise) publish upstream builds, and installing one
 * would replace this fork, so `omp update` never does.
 */
export const FORK_UPDATE_HINT =
	"This is an oh-my-tau build: update it by running ./scripts/install-harness.sh again from your oh-my-tau checkout (the installer keeps one at ~/.omp/src/oh-my-pi).";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

	static examples = ["omp update", "omp update --plugins"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		if (!flags.plugins) {
			process.stdout.write(`${FORK_UPDATE_HINT}\n`);
			return;
		}
		await initTheme();
		await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
	}
}
