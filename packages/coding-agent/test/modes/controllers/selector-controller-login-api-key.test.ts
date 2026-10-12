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
const WORKSPACES = [
	{ id: "wrkspc_01DEFAULTworkspace", name: "Default Workspace" },
	{ id: "wrkspc_01CREDITSworkspace", name: "Credits" },
];

/**
 * Stand-in for the Anthropic API a key is checked against: `/v1/models` answers
 * a scoped key, an unscoped key only with a workspace it can use, and the
 * workspace list is open unless `listable` is false.
 */
function installAnthropicApi(options: { scoped: boolean; listable?: boolean }): string[] {
	const workspaceHeaders: string[] = [];
	const api = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		const url = new URL(request.url);
		if (request.headers.get("x-api-key") !== CONSOLE_KEY) return Response.json({ type: "error" }, { status: 401 });
		if (url.pathname === "/v1/organizations/workspaces") {
			if (options.listable === false) return Response.json({ type: "error" }, { status: 403 });
			return Response.json({ data: WORKSPACES.map(workspace => ({ ...workspace, archived_at: null })) });
		}
		const workspace = request.headers.get("anthropic-workspace-id");
		if (workspace) workspaceHeaders.push(workspace);
		if (options.scoped || WORKSPACES.some(entry => entry.id === workspace)) return Response.json({ data: [] });
		const message = workspace
			? "This API key cannot use that workspace"
			: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header";
		return Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 });
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(Object.assign(api, { preconnect: globalThis.fetch.preconnect }));
	return workspaceHeaders;
}

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
		installAnthropicApi({ scoped: true });
		ctx.showHookSelector = vi.fn(async () => "Add API key");

		const login = controller.showOAuthSelector("login", "anthropic");
		const dialog = await dialogShown;
		dialog.pasteText(CONSOLE_KEY);
		expect(rendered(dialog)).not.toContain("CONSOLEKEYsecret");
		dialog.handleInput("\r");
		await login;

		expect(authStorage.credentials.pooledApiKeys("anthropic").map(row => row.credential)).toEqual([
			{ type: "api_key", key: CONSOLE_KEY, source: "login" },
		]);
		const message = presented.map(rendered).join("\n");
		expect(message).toContain("added to anthropic (1 pooled key)");
		expect(message).not.toContain("CONSOLEKEYsecret");
		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("has the user pick the workspace of a key that is not scoped to one", async () => {
		const verified = installAnthropicApi({ scoped: false });
		let editorWhilePicking: unknown;
		const offered: unknown[] = [];
		ctx.showHookSelector = vi.fn(async (_title: string, items: unknown[]) => {
			offered.push(items);
			if (offered.length === 1) return "Add API key";
			editorWhilePicking = [...ctx.editorContainer.children];
			return "Credits (wrkspc_01CREDITSworkspace)";
		});

		const login = controller.showOAuthSelector("login", "anthropic");
		const dialog = await dialogShown;
		dialog.pasteText(CONSOLE_KEY);
		dialog.handleInput("\r");
		await login;

		expect(offered[1]).toEqual([
			"Default Workspace (wrkspc_01DEFAULTworkspace)",
			"Credits (wrkspc_01CREDITSworkspace)",
		]);
		// The selector took the editor slot from the dialog, not from under it.
		expect(editorWhilePicking).toEqual([ctx.editor]);
		expect(verified).toEqual(["wrkspc_01CREDITSworkspace"]);
		expect(authStorage.credentials.pooledApiKeys("anthropic").map(row => row.credential.workspaceId)).toEqual([
			"wrkspc_01CREDITSworkspace",
		]);
		const message = presented.map(rendered).join("\n");
		expect(message).toContain("added to anthropic, workspace wrkspc_01CREDITSworkspace (1 pooled key)");
		expect(message).not.toContain("CONSOLEKEYsecret");
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("asks for the workspace ID when the key may not list workspaces", async () => {
		installAnthropicApi({ scoped: false, listable: false });
		ctx.showHookSelector = vi.fn(async () => "Add API key");

		const login = controller.showOAuthSelector("login", "anthropic");
		const dialog = await dialogShown;
		const workspacePrompt = Promise.withResolvers<void>();
		const showPrompt = dialog.showPrompt.bind(dialog);
		vi.spyOn(dialog, "showPrompt").mockImplementation(prompt => {
			const answer = showPrompt(prompt);
			if (!prompt.secret) workspacePrompt.resolve();
			return answer;
		});
		dialog.pasteText(CONSOLE_KEY);
		dialog.handleInput("\r");
		await workspacePrompt.promise;
		expect(rendered(dialog)).toContain("platform.claude.com/settings/workspaces");
		dialog.pasteText("wrkspc_01DEFAULTworkspace");
		dialog.handleInput("\r");
		await login;

		expect(authStorage.credentials.pooledApiKeys("anthropic").map(row => row.credential.workspaceId)).toEqual([
			"wrkspc_01DEFAULTworkspace",
		]);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("stores nothing for a key Anthropic rejects", async () => {
		installAnthropicApi({ scoped: true });
		ctx.showHookSelector = vi.fn(async () => "Add API key");

		const login = controller.showOAuthSelector("login", "anthropic");
		const dialog = await dialogShown;
		dialog.pasteText("sk-ant-api03-REVOKEDkey0000000000000000");
		dialog.handleInput("\r");
		await login;

		expect(authStorage.credentials.list("anthropic")).toEqual([]);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("validation failed (401)"));
		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
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
