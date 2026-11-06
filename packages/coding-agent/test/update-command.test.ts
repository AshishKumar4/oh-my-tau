import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as pluginCli from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import Update, { FORK_UPDATE_HINT } from "@oh-my-pi/pi-coding-agent/commands/update";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const write = spyOn(process.stdout, "write").mockReturnValue(true);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(write).not.toHaveBeenCalledWith(`${FORK_UPDATE_HINT}\n`);
	});

	it("points an oh-my-tau build at its installer instead of an upstream release", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const write = spyOn(process.stdout, "write").mockReturnValue(true);

		const command = new Update([], TEST_CONFIG);
		await command.run();

		expect(write).toHaveBeenCalledWith(`${FORK_UPDATE_HINT}\n`);
		expect(FORK_UPDATE_HINT).toContain("./scripts/install-harness.sh");
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});
