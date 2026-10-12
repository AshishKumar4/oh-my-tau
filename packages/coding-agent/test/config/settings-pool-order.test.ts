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
import { cfgProvidersMaxInFlightRequests } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
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
let projectDir: string;
let authStorage: AuthStorage | undefined;
let sync: AuthStorageSettingsSync | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	state = beginSettingsTest();
	for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"]) delete process.env[key];
	tempDir = TempDir.createSync("@pi-settings-pool-order-");
	agentDir = tempDir.join("agent");
	projectDir = tempDir.join("project");
	for (const dir of [agentDir, path.join(projectDir, ".omp")]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	sync?.stop();
	authStorage?.close();
	sync = undefined;
	authStorage = undefined;
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	tempDir.removeSync();
});

/** Loads settings (with an optional project config) and a live auth storage holding a subscription and a pooled key. */
async function start(projectConfig?: object): Promise<AuthStorage> {
	if (projectConfig) await Bun.write(path.join(projectDir, ".omp", "config.yml"), YAML.stringify(projectConfig));
	await Settings.init({ cwd: projectDir, agentDir });
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(agentDir, "credentials.db")));
	await storage.credentials.upsert("anthropic", {
		type: "oauth",
		access: "subscription-token",
		refresh: "subscription-refresh",
		expires: Date.now() + 3_600_000,
		email: "max@example.com",
	});
	await storage.credentials.addApiKey("anthropic", POOLED_KEY);
	// The running session's link: a /settings change re-applies routing policy live.
	sync = createAuthStorageSettingsSync(settings, storage);
	authStorage = storage;
	return storage;
}

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

const NATIVE_PAGE: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

/** How many Providers settings differ from their default, as the native settings page counts them. */
function providersChanged(selector: SettingsSelectorComponent): number | undefined {
	const described = selector.describe(NATIVE_PAGE);
	if (described.k !== "prefs" || !described.p) throw new Error(`described ${described.k}, not prefs`);
	return described.p.pages.find(page => page.id === "providers")?.changed;
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
	await sync?.settled();
	return providerList;
}

async function globalConfig(): Promise<unknown> {
	await settings.flush();
	return YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) ?? {};
}

it("switching a provider to API keys first in /settings makes the running session serve its pooled key", async () => {
	const storage = await start();
	expect(await storage.keys.get("anthropic")).toBe("subscription-token");
	const selector = createSelector();
	// Nothing configured: the empty records match their defaults.
	expect(providersChanged(selector)).toBeUndefined();

	const providerList = await chooseForAnthropic(selector, DOWN);

	expect(providerList).toContain("anthropic");
	expect(providerList).toContain("Subscriptions first (default)");
	expect(cfgAuthPoolOrder.get(settings)).toEqual({ anthropic: "api-keys-first" });
	expect(providersChanged(selector)).toBe(1);
	expect(await storage.keys.get("anthropic")).toBe(POOLED_KEY);
	expect(await globalConfig()).toEqual({ auth: { poolOrder: { anthropic: "api-keys-first" } } });
});

it("choosing the default order again removes the entry and restores the subscription", async () => {
	const storage = await start();
	await chooseForAnthropic(createSelector(), DOWN);
	expect(await storage.keys.get("anthropic")).toBe(POOLED_KEY);

	const selector = createSelector();
	const providerList = await chooseForAnthropic(selector, UP);

	expect(providerList).toContain("API keys first");
	expect(cfgAuthPoolOrder.get(settings)).toEqual({});
	expect(providersChanged(selector)).toBeUndefined();
	expect(await storage.keys.get("anthropic")).toBe("subscription-token");
	expect(JSON.stringify(await globalConfig())).not.toContain("anthropic");
});

it("editing one provider never copies project-level entries into the global config", async () => {
	await start({ auth: { poolOrder: { zai: "api-keys-first" } }, providers: { maxInFlightRequests: { zai: 2 } } });

	const providerList = await chooseForAnthropic(createSelector(), DOWN);
	const limits = createSelector();
	for (const ch of "max in-flight requests") limits.handleInput(ch);
	limits.handleInput(ENTER); // provider list: anthropic sorts first
	limits.handleInput(ENTER); // limit field
	for (const ch of "3") limits.handleInput(ch);
	limits.handleInput(ENTER);

	// The project's zai entries still apply and show in the panel...
	expect(providerList).toContain("zai");
	expect(cfgAuthPoolOrder.get(settings)).toEqual({ anthropic: "api-keys-first", zai: "api-keys-first" });
	expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ anthropic: 3, zai: 2 });
	// ...but only the edited anthropic entries reach the global config.
	expect(await globalConfig()).toEqual({
		auth: { poolOrder: { anthropic: "api-keys-first" } },
		providers: { maxInFlightRequests: { anthropic: 3 } },
	});
});
