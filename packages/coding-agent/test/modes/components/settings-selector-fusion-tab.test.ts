import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTING_TABS, TAB_METADATA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import type { SymbolKey } from "@oh-my-pi/pi-coding-agent/modes/theme/symbols";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

/** Step the tab bar right until the Fusion tab is active (tab order is SETTING_TABS order). */
function focusFusionTab(comp: SettingsSelectorComponent): void {
	const index = SETTING_TABS.indexOf("fusion");
	for (let i = 0; i < index; i++) {
		comp.handleInput("\x1b[C");
	}
}

describe("SettingsSelectorComponent fusion tab", () => {
	it("places Fusion directly after Tasks and renders its tab with a resolved icon", () => {
		expect(SETTING_TABS[SETTING_TABS.indexOf("tasks") + 1]).toBe("fusion");

		const comp = createSelector();
		const icon = theme.symbol(TAB_METADATA.fusion.icon as SymbolKey);
		expect(icon.length).toBeGreaterThan(0);
		// Inactive tabs collapse to their icon at 120 columns; the active tab keeps its full label.
		focusFusionTab(comp);
		const rendered = Bun.stripANSI(comp.render(120).join("\n"));
		expect(rendered).toContain(`${icon} ${TAB_METADATA.fusion.label}`);
		expect(rendered.indexOf(`${icon} ${TAB_METADATA.fusion.label}`)).toBeGreaterThan(
			rendered.indexOf(theme.symbol(TAB_METADATA.tasks.icon as SymbolKey)),
		);
	});

	it("shows the fusion settings rows and toggles fusion.enabled from the tab", () => {
		const comp = createSelector();
		focusFusionTab(comp);
		// Width 70 keeps the flat single-column layout so every row renders inline.
		const before = Bun.stripANSI(comp.render(70).join("\n"));
		expect(before).toContain("Sidekick Model");
		expect(before).toContain("Sidekick Thinking");

		// The boolean "Fusion" row is first in the tab; Enter toggles it.
		expect(settings.get("fusion.enabled")).toBe(false);
		comp.handleInput("\n");
		expect(settings.get("fusion.enabled")).toBe(true);
	});
});
