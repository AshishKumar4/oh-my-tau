import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { cfgAuthPoolOrder } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import {
	type AuthStorageSettingsSync,
	createAuthStorageSettingsSync,
} from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const ENTER = "\n";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const POOLED_KEY = "sk-ant-api03-POOLEDkeyForSettingsTest0001";

let state: SettingsTestState | undefined;
let tempDir: TempDir;
let agentDir: string;
let authStorage: AuthStorage;
let sync: AuthStorageSettingsSync;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	state = beginSettingsTest();
	for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"]) delete process.env[key];
	tempDir = TempDir.createSync("@pi-settings-pool-order-");
	agentDir = tempDir.join("agent");
	const projectDir = tempDir.join("project");
	for (const dir of [agentDir, projectDir]) fs.mkdirSync(dir, { recursive: true });
	await Settings.init({ cwd: projectDir, agentDir });

	authStorage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(agentDir, "credentials.db")));
	await authStorage.credentials.upsert("anthropic", {
		type: "oauth",
		access: "subscription-token",
		refresh: "subscription-refresh",
		expires: Date.now() + 3_600_000,
		email: "max@example.com",
	});
	await authStorage.credentials.addApiKey("anthropic", POOLED_KEY);
	// The running session's link: a /settings change re-applies routing policy live.
	sync = createAuthStorageSettingsSync(settings, authStorage);
});

afterEach(() => {
	sync.stop();
	authStorage.close();
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	tempDir.removeSync();
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: ["openai-codex", "anthropic"],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

function screen(selector: SettingsSelectorComponent): string {
	return Bun.stripANSI(selector.render(120).join("\n"));
}

/** Opens Credential Pool Order, picks anthropic, then moves `steps` through the choices and saves. */
async function chooseForAnthropic(selector: SettingsSelectorComponent, steps: string): Promise<string> {
	for (const ch of "credential pool order") selector.handleInput(ch);
	selector.handleInput(ENTER);
	const providerList = screen(selector);
	selector.handleInput(ENTER);
	selector.handleInput(steps);
	selector.handleInput(ENTER);
	// The coalesced settings listener delivers the change on the next microtask.
	await Promise.resolve();
	await sync.settled();
	return providerList;
}

it("switching a provider to API keys first in /settings makes the running session serve its pooled key", async () => {
	expect(await authStorage.keys.get("anthropic")).toBe("subscription-token");

	const providerList = await chooseForAnthropic(createSelector(), DOWN);

	expect(providerList).toContain("anthropic");
	expect(providerList).toContain("Subscriptions first (default)");
	expect(cfgAuthPoolOrder.get(settings)).toEqual({ anthropic: "api-keys-first" });
	expect(await authStorage.keys.get("anthropic")).toBe(POOLED_KEY);
	await settings.flush();
	expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({
		auth: { poolOrder: { anthropic: "api-keys-first" } },
	});
});

it("choosing the default order again removes the entry and restores the subscription", async () => {
	await chooseForAnthropic(createSelector(), DOWN);
	expect(await authStorage.keys.get("anthropic")).toBe(POOLED_KEY);

	const providerList = await chooseForAnthropic(createSelector(), UP);

	expect(providerList).toContain("API keys first");
	expect(cfgAuthPoolOrder.get(settings)).toEqual({});
	expect(await authStorage.keys.get("anthropic")).toBe("subscription-token");
	await settings.flush();
	const config: unknown = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text());
	expect(JSON.stringify(config ?? {})).not.toContain("poolOrder");
});
