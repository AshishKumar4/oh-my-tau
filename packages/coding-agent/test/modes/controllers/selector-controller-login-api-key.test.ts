import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Component } from "@oh-my-pi/pi-tui";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const CONSOLE_KEY = "sk-ant-api03-CONSOLEKEYsecretPART0123456789";

describe("/login API key entry", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let ctx: InteractiveModeContext;
	let controller: SelectorController;
	let dialogShown: Promise<LoginDialogComponent>;
	let presented: Component[];

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-login-api-key-"));
		// Opened directly, never through discovery: a configured auth broker must
		// not receive the test's keys, nor may the user's model cache be touched.
		authStorage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await authStorage.credentials.reload();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			ignoreLocalModelConfig: true,
			cacheDbPath: path.join(tempDir, "models.db"),
		});
		// Model discovery is a network seam; the flow under test is credential entry.
		vi.spyOn(modelRegistry, "refreshProvider").mockResolvedValue(undefined);
		ctx = createInteractiveModeContext({ session: { modelRegistry, sessionId: "session-1" } });
		const shown = Promise.withResolvers<LoginDialogComponent>();
		dialogShown = shown.promise;
		// The controller focuses the dialog once it is mounted and ready for input.
		ctx.ui.setFocus = vi.fn((component: Component | null) => {
			if (component instanceof LoginDialogComponent) shown.resolve(component);
		});
		presented = [];
		ctx.present = vi.fn((content: Component | readonly Component[]) => {
			presented.push(...[content].flat());
		});
		controller = new SelectorController(ctx);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		await removeWithRetries(tempDir);
	});

	function rendered(component: Component): string {
		return component.render(120).map(Bun.stripANSI).join("\n");
	}

	it("adds a masked API key to the provider's key pool", async () => {
		ctx.showHookSelector = vi.fn(async () => "Add API key");

		const login = controller.showOAuthSelector("login", "anthropic");
		const dialog = await dialogShown;
		dialog.pasteText(CONSOLE_KEY);
		expect(rendered(dialog)).not.toContain("CONSOLEKEYsecret");
		dialog.handleInput("\r");
		await login;

		expect(authStorage.credentials.pooledApiKeys("anthropic").map(row => row.credential.key)).toEqual([CONSOLE_KEY]);
		const message = presented.map(rendered).join("\n");
		expect(message).toContain("added to anthropic (1 pooled key)");
		expect(message).not.toContain("CONSOLEKEYsecret");
		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("stores nothing when the key prompt is cancelled", async () => {
		ctx.showHookSelector = vi.fn(async () => "Add API key");
		const oauthLogin = vi.spyOn(authStorage.oauth, "login");

		const login = controller.showOAuthSelector("login", "anthropic");
		const dialog = await dialogShown;
		dialog.pasteText(CONSOLE_KEY);
		dialog.handleInput("\x1b");
		await login;

		expect(authStorage.credentials.list("anthropic")).toEqual([]);
		expect(oauthLogin).not.toHaveBeenCalled();
		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("stores nothing when Esc follows Enter in the same input batch", async () => {
		ctx.showHookSelector = vi.fn(async () => "Add API key");

		const login = controller.showOAuthSelector("login", "anthropic");
		const dialog = await dialogShown;
		dialog.pasteText(CONSOLE_KEY);
		dialog.handleInput("\r");
		dialog.handleInput("\x1b");
		await login;

		expect(authStorage.credentials.list("anthropic")).toEqual([]);
		expect(presented).toEqual([]);
		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
	});

	it("runs the subscription sign-in when the browser option is chosen", async () => {
		ctx.showHookSelector = vi.fn(async () => "Sign in with browser");
		const oauthLogin = vi.spyOn(authStorage.oauth, "login").mockResolvedValue(undefined);

		await controller.showOAuthSelector("login", "anthropic");

		expect(oauthLogin).toHaveBeenCalledWith("anthropic", expect.anything());
		expect(authStorage.credentials.pooledApiKeys("anthropic")).toEqual([]);
	});

	it("goes straight to sign-in for a provider that takes no API key", async () => {
		const oauthLogin = vi.spyOn(authStorage.oauth, "login").mockResolvedValue(undefined);

		await controller.showOAuthSelector("login", "openai-codex");

		expect(ctx.showHookSelector).not.toHaveBeenCalled();
		expect(oauthLogin).toHaveBeenCalledWith("openai-codex", expect.anything());
	});
});
