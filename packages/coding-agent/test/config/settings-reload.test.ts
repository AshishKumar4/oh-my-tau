import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disableProvider, enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { acquireFileLock, getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgEditModelVariants } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgSteeringMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgTodoRemindersMax, cfgDevAutoqaConsent } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgProvidersMaxInFlightRequests, cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("Settings layer refresh", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let startProject: string;
	let scopedProject: string;
	let bareProject: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-reload-");
		agentDir = tempDir.join("agent");
		startProject = tempDir.join("start");
		scopedProject = tempDir.join("scoped");
		bareProject = tempDir.join("bare");
		for (const dir of [agentDir, startProject, bareProject]) fs.mkdirSync(dir, { recursive: true });
		writeProjectSettings(scopedProject, { compaction: { enabled: false } });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const writeConfig = (settings: Record<string, unknown>) => Bun.write(configPath(), YAML.stringify(settings));

	function writeProjectSettings(project: string, settings: Record<string, unknown>): void {
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
		fs.writeFileSync(path.join(getProjectAgentDir(project), "settings.json"), JSON.stringify(settings));
	}

	it("rejects an on-disk value that fails validation and keeps the previous layers", async () => {
		await writeConfig({ providers: { maxInFlightRequests: { openai: 2 } } });
		const settings = await Settings.init({ cwd: startProject, agentDir });

		await writeConfig({ providers: { maxInFlightRequests: { openai: 0 } } });
		await expect(settings.reloadFromDisk()).rejects.toThrow("Provider request limits must be positive numbers");
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2 });
	});

	it("never adopts an invalid on-disk value through the save that merges external edits", async () => {
		await writeConfig({ providers: { maxInFlightRequests: { openai: 2 } } });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		await writeConfig({ providers: { maxInFlightRequests: { openai: 0 } } });
		await expect(settings.reloadFromDisk()).rejects.toThrow("Provider request limits must be positive numbers");

		cfgTemperature.set(settings, 0.5);
		await settings.flush();
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2 });
		expect(cfgTemperature.get(settings)).toBe(0.5);
		// The file keeps the external edit for the user to fix, merged with the save.
		expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({
			providers: { maxInFlightRequests: { openai: 0 } },
			temperature: 0.5,
		});
	});

	it("keeps global writes made while a save waits on the lock live and persists them next", async () => {
		await writeConfig({ compaction: { enabled: false } });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange([cfgTemperature, cfgCompactionEnabled, cfgProvidersMaxInFlightRequests], setting => {
			seen.push([setting.id, setting.get(settings)]);
		});

		// Another writer holds config.yml's lock: the save snapshots its pending write, then waits.
		const lock = await acquireFileLock(configPath());
		cfgTemperature.set(settings, 0.5);
		const saving = settings.flush();
		cfgCompactionEnabled.unset(settings);
		cfgProvidersMaxInFlightRequests.set(settings, { openai: 3 });
		lock.release();
		await saving;

		expect(cfgCompactionEnabled.get(settings)).toBe(true);
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 3 });
		await settings.flush();
		expect(seen).toEqual([
			["temperature", 0.5],
			["compaction.enabled", true],
			["providers.maxInFlightRequests", { openai: 3 }],
		]);
		expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({
			temperature: 0.5,
			providers: { maxInFlightRequests: { openai: 3 } },
		});
	});

	it("persists a setting written again while its save waits on the lock without a stale-edit warning", async () => {
		await writeConfig({ temperature: 0.1 });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		const warn = spyOn(logger, "warn");
		try {
			const lock = await acquireFileLock(configPath());
			cfgTemperature.set(settings, 0.5);
			const saving = settings.flush();
			cfgTemperature.set(settings, 0.7);
			lock.release();
			await saving;
			expect(cfgTemperature.get(settings)).toBe(0.7);

			await settings.flush();
			expect(warn).not.toHaveBeenCalled();
			expect(cfgTemperature.get(settings)).toBe(0.7);
			expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({ temperature: 0.7 });
		} finally {
			warn.mockRestore();
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reloads over unsaved changes and writes them after the target becomes writable",
		async () => {
			const directory = tempDir.join("readonly");
			fs.mkdirSync(directory);
			const target = path.join(directory, "config.yml");
			fs.writeFileSync(target, YAML.stringify({ temperature: 0.1, modelRoles: { default: "openai/base" } }));
			fs.symlinkSync(target, configPath());
			fs.chmodSync(directory, 0o555);
			const settings = await Settings.init({ cwd: startProject, agentDir });
			try {
				cfgTemperature.set(settings, 0.5);
				settings.setModelRole("default", "openai/session");
				settings.setProjectModelRole("slow", "openai/project");
				await expect(settings.flush()).rejects.toThrow();
				await settings.reloadFromDisk();
				await settings.reloadFromDisk();
				expect(cfgTemperature.get(settings)).toBe(0.5);
				expect(settings.getModelRole("default")).toBe("openai/session");
				expect(settings.getProjectModelRole("slow")).toBe("openai/project");
				fs.chmodSync(directory, 0o755);
				await settings.reloadFromDisk();
				expect(YAML.parse(await Bun.file(target).text())).toEqual({
					temperature: 0.5,
					modelRoles: { default: "openai/session" },
				});
			} finally {
				fs.chmodSync(directory, 0o755);
			}
		},
	);

	it.each([false, true])(
		"keeps each quarantined file at its normal precedence, fresh foreign source=%s",
		async foreignEnabled => {
			await writeConfig({ temperature: 0.1, compaction: { enabled: true }, modelRoles: { default: "openai/base" } });
			const projectConfig = path.join(getProjectAgentDir(startProject), "config.yml");
			fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
			await Bun.write(
				projectConfig,
				YAML.stringify({ temperature: 0.2, compaction: { enabled: false }, modelRoles: { plan: "openai/plan" } }),
			);
			const settings = await Settings.init({ cwd: startProject, agentDir });
			cfgTemperature.set(settings, 0.5);
			settings.setProjectModelRole("slow", "openai/project");
			if (foreignEnabled) {
				const foreign = path.join(startProject, ".claude", "settings.json");
				fs.mkdirSync(path.dirname(foreign), { recursive: true });
				await Bun.write(foreign, JSON.stringify({ temperature: 0.8 }));
			}
			await Bun.write(configPath(), "temperature: [\n");
			await Bun.write(projectConfig, "modelRoles: [\n");
			await settings.reloadFromDisk();
			expect(cfgTemperature.get(settings)).toBe(foreignEnabled ? 0.8 : 0.2);
			expect(cfgCompactionEnabled.get(settings)).toBe(false);
			expect(settings.getModelRole("default")).toBe("openai/base");
			expect(settings.getProjectModelRole("plan")).toBe("openai/plan");
			expect(settings.getProjectModelRole("slow")).toBe("openai/project");
			await settings.flush();
			expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({
				temperature: 0.5,
				compaction: { enabled: true },
				modelRoles: { default: "openai/base" },
			});
			expect(YAML.parse(await Bun.file(projectConfig).text())).toEqual({
				temperature: 0.2,
				compaction: { enabled: false },
				modelRoles: { plan: "openai/plan", slow: "openai/project" },
			});
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"honors a recreated empty project file while its pending save remains blocked",
		async () => {
			await writeConfig({ temperature: 0.1, compaction: { enabled: true } });
			const projectConfig = path.join(getProjectAgentDir(startProject), "config.yml");
			fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
			await Bun.write(
				projectConfig,
				YAML.stringify({
					temperature: 0.2,
					compaction: { enabled: false },
					modelRoles: { plan: "openai/old-plan" },
				}),
			);
			const settings = await Settings.init({ cwd: startProject, agentDir });
			settings.setProjectModelRole("slow", "openai/pending");
			await Bun.write(projectConfig, "modelRoles: [\n");
			await expect(settings.flush()).rejects.toThrow();
			await Bun.write(projectConfig, "");
			fs.chmodSync(path.dirname(projectConfig), 0o555);
			try {
				await settings.reloadFromDisk();
				expect(cfgTemperature.get(settings)).toBe(0.1);
				expect(cfgCompactionEnabled.get(settings)).toBe(true);
				expect(settings.getProjectModelRole("plan")).toBeUndefined();
				expect(settings.getProjectModelRole("slow")).toBe("openai/pending");
				fs.chmodSync(path.dirname(projectConfig), 0o755);
				await settings.flush();
				expect(YAML.parse(await Bun.file(projectConfig).text())).toEqual({
					modelRoles: { slow: "openai/pending" },
				});
			} finally {
				fs.chmodSync(path.dirname(projectConfig), 0o755);
			}
		},
	);

	it("keeps a distinct provider's fresh contribution when it shares the native file path", async () => {
		const projectConfig = path.join(getProjectAgentDir(startProject), "config.yml");
		fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
		await Bun.write(
			projectConfig,
			YAML.stringify({ temperature: 0.2, compaction: { enabled: false }, modelRoles: { plan: "openai/original" } }),
		);
		const script = `
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { registerProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { settingsCapability } from "@oh-my-pi/pi-coding-agent/capability/settings";
const file = ${JSON.stringify(projectConfig)};
let temperature = 0.3;
registerProvider(settingsCapability.id, { id: "fixture-shared-path", displayName: "Fixture", description: "Fixture", priority: 1,
  async load() { return { items: [{ path: file, data: { temperature }, level: "project", _source: { provider: "fixture-shared-path", providerName: "Fixture", path: file, level: "project" } }] }; }
});
const settings = await Settings.init({ cwd: ${JSON.stringify(startProject)}, agentDir: ${JSON.stringify(agentDir)} });
try {
  if (cfgTemperature.get(settings) !== 0.3) throw new Error("Initial source precedence changed");
  temperature = 0.9;
  settings.setProjectModelRole("slow", "openai/pending");
  await Bun.write(file, "modelRoles: [\\n");
  await settings.reloadFromDisk();
  if (cfgTemperature.get(settings) !== 0.9 || cfgCompactionEnabled.get(settings) !== false) throw new Error("Provider identity or native last-good data was lost");
  if (settings.getProjectModelRole("plan") !== "openai/original" || settings.getProjectModelRole("slow") !== "openai/pending") throw new Error("Role ownership changed");
  await settings.flush();
} finally { settings.cancelPendingSaves(); AgentStorage.close(); }
`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: process.cwd(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 15_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
	});

	it.each(["valid", "quarantine", "disabled-quarantine"])("keeps raw alias precedence through %s", async mode => {
		const native = path.join(getProjectAgentDir(startProject), "config.yml");
		const foreign = path.join(startProject, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(native), { recursive: true });
		fs.mkdirSync(path.dirname(foreign), { recursive: true });
		await Bun.write(native, YAML.stringify({ queueMode: "one-at-a-time", compaction: { enabled: false } }));
		await Bun.write(foreign, JSON.stringify({ queueMode: "all" }));
		const settings = await Settings.init({ cwd: startProject, agentDir });
		expect(cfgSteeringMode.get(settings)).toBe("all");
		if (mode === "disabled-quarantine") {
			disableProvider("native");
			await settings.reloadFromDisk();
			expect(cfgSteeringMode.get(settings)).toBe("all");
			enableProvider("native");
		}
		if (mode !== "valid") {
			settings.setProjectModelRole("slow", "openai/pending");
			await Bun.write(native, "queueMode: [\n");
		}
		await settings.reloadFromDisk();
		expect(cfgSteeringMode.get(settings)).toBe("all");
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		if (mode !== "valid") expect(settings.getProjectModelRole("slow")).toBe("openai/pending");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"retains nested legacy settings through repeated blocked reloads and recovery",
		async () => {
			const file = path.join(getProjectAgentDir(startProject), "config.yml");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			await Bun.write(
				file,
				YAML.stringify({ dev: { autoqa: { consent: "denied" } }, todo: { reminders: { max: 7 } } }),
			);
			const settings = await Settings.init({ cwd: startProject, agentDir });
			settings.setProjectModelRole("slow", "openai/pending");
			await Bun.write(file, "todo: [\n");
			await expect(settings.flush()).rejects.toThrow();
			fs.chmodSync(path.dirname(file), 0o555);
			try {
				await settings.reloadFromDisk();
				expect(cfgDevAutoqaConsent.get(settings)).toBe("denied");
				expect(cfgTodoRemindersMax.get(settings)).toBe(7);
				await settings.reloadFromDisk();
				expect(cfgDevAutoqaConsent.get(settings)).toBe("denied");
				expect(cfgTodoRemindersMax.get(settings)).toBe(7);
				fs.chmodSync(path.dirname(file), 0o755);
				await settings.flush();
				expect(YAML.parse(await Bun.file(file).text())).toMatchObject({
					dev: { autoqaConsent: "denied" },
					todo: { remindersMax: 7 },
					modelRoles: { slow: "openai/pending" },
				});
			} finally {
				fs.chmodSync(path.dirname(file), 0o755);
			}
		},
	);

	it("notifies listeners when a reload only reorders a precedence-sensitive record", async () => {
		await writeConfig({ edit: { modelVariants: { claude: "patch", sonnet: "replace" } } });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		const seen: string[][] = [];
		cfgEditModelVariants.listen(settings, value => {
			seen.push(Object.keys(value));
		});

		await writeConfig({ edit: { modelVariants: { sonnet: "replace", claude: "patch" } } });
		await settings.reloadFromDisk();
		expect(Object.keys(cfgEditModelVariants.get(settings))).toEqual(["sonnet", "claude"]);
		await Promise.resolve();
		expect(seen).toEqual([["sonnet", "claude"]]);
	});

	it("refuses to re-scope into a project whose settings fail validation", async () => {
		writeProjectSettings(bareProject, { providers: { maxInFlightRequests: { openai: -1 } } });
		const settings = await Settings.init({ cwd: scopedProject, agentDir });
		let notified = false;
		cfgCompactionEnabled.listen(settings, () => {
			notified = true;
		});

		await expect(settings.reloadForCwd(bareProject)).rejects.toThrow(
			"Provider request limits must be positive numbers",
		);
		await Promise.resolve();
		expect(settings.getCwd()).toBe(path.normalize(scopedProject));
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		expect(notified).toBe(false);
	});

	it("never leaves a re-scoped instance on the previous project's layer when a reload overlaps", async () => {
		const settings = await Settings.init({ cwd: scopedProject, agentDir });
		for (let round = 0; round < 4; round++) {
			await settings.reloadForCwd(scopedProject);
			expect(cfgCompactionEnabled.get(settings)).toBe(false);

			await Promise.all([settings.reloadFromDisk(), settings.reloadForCwd(bareProject)]);
			expect(settings.getCwd()).toBe(path.normalize(bareProject));
			expect(cfgCompactionEnabled.get(settings)).toBe(true);
		}
	});

	it("drops a pinned default once a reloaded or cloned scope configures the setting", async () => {
		const settings = await Settings.init({ cwd: startProject, agentDir });
		cfgCompactionEnabled.pinDefault(settings);
		expect(cfgCompactionEnabled.provenance(settings)).toBe("runtime");

		const clone = await settings.cloneForCwd(scopedProject);
		expect(cfgCompactionEnabled.get(clone)).toBe(false);
		expect(cfgCompactionEnabled.provenance(clone)).toBe("project");

		await writeConfig({ compaction: { enabled: false } });
		await settings.reloadFromDisk();
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		expect(cfgCompactionEnabled.provenance(settings)).toBe("global");
	});
});
