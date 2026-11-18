import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe.skipIf(process.platform === "win32")("live settings through physical symlink paths", () => {
	let state: SettingsTestState | undefined;
	let settings: Settings | undefined;
	let directory: TempDir | undefined;
	beforeEach(() => {
		state = beginSettingsTest();
	});
	afterEach(async () => {
		settings?.stopWatching();
		restoreSettingsTestState(state);
		AgentStorage.close();
		await directory?.remove();
	});
	it("reads edits before watch arming, observes directory retargeting and follows the new destination", async () => {
		directory = TempDir.createSync("@pi-config-watch-");
		const agentDir = directory.join("agent");
		const cwd = directory.join("project");
		const first = directory.join("first");
		const second = directory.join("second");
		const alias = directory.join("current");
		for (const dir of [agentDir, cwd, first, second]) await fs.mkdir(dir);
		await Bun.write(path.join(first, "config.yml"), "temperature: 0.1\n");
		await Bun.write(path.join(second, "config.yml"), "temperature: 0.3\n");
		await fs.symlink(first, alias, "dir");
		await fs.symlink(path.join(alias, "config.yml"), path.join(agentDir, "config.yml"));
		const live = await Settings.init({ cwd, agentDir });
		settings = live;
		const waitFor = (temperature: number) => {
			const completion = Promise.withResolvers<void>();
			const unsubscribe = live.onEffectiveChange([cfgTemperature], () => {
				if (cfgTemperature.get(live) === temperature) completion.resolve();
			});
			return completion.promise.finally(unsubscribe);
		};
		await Bun.write(path.join(first, "config.yml"), "temperature: 0.2\n");
		const armed = waitFor(0.2);
		live.startWatching();
		await armed;
		expect(cfgTemperature.get(live)).toBe(0.2);
		const retargeted = waitFor(0.4);
		await fs.unlink(alias);
		await fs.symlink(second, alias, "dir");
		await Bun.write(path.join(second, "config.yml"), "temperature: 0.4\n");
		await retargeted;
		expect(cfgTemperature.get(live)).toBe(0.4);
		const changed = waitFor(0.6);
		await Bun.write(path.join(second, "config.yml"), "temperature: 0.6\n");
		await changed;
		expect(cfgTemperature.get(live)).toBe(0.6);
		cfgTemperature.set(live, 0.7);
		await live.flush();
		expect((await fs.lstat(path.join(agentDir, "config.yml"))).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
		expect(await Bun.file(path.join(second, "config.yml")).text()).toContain("0.7");
	});
});
