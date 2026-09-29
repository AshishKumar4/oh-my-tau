import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HARNESS_CAPTURE_SCHEMA, loadHarnessPrompt } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { withHarnessCacheDir } from "../helpers/harness";

function required(model: Model | undefined, what: string): Model {
	if (!model) throw new Error(`expected ${what} in the bundled catalog`);
	return model;
}

const FABLE = required(getBundledModel("anthropic", "claude-fable-5-1"), "anthropic/claude-fable-5-1");
const SONNET = required(getBundledModel("anthropic", "claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");

const CAPTURE = {
	schema: HARNESS_CAPTURE_SCHEMA,
	profile: "claude-code",
	clientVersion: "2.1.267.d7f",
	entrypoint: "cli",
	capturedAt: "2026-09-09T12:00:00.000Z",
	instructions: ["You are an interactive agent.\n\n# Tone\n\nBe terse."],
	tools: ["Bash", "Read"],
	ambient: [],
};

async function runModelCommand(model: Model): Promise<string> {
	const spec = lookupBuiltinSlashCommand("model");
	if (!spec?.handle) throw new Error("expected a /model handler");
	const emitted: string[] = [];
	await spec.handle({ name: "model", args: "", text: "/model" }, {
		session: { model },
		settings: Settings.isolated(),
		output: (text: string) => {
			emitted.push(text);
		},
	} as unknown as SlashCommandRuntime);
	return emitted.join("\n");
}

describe("/model harness capture notice", () => {
	const dirs = withHarnessCacheDir("omp-model-harness-notice-");

	async function serveCapture(): Promise<void> {
		const dir = path.join(dirs.cache, "claude-code");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "2.1.267.d7f-cli.json"), JSON.stringify(CAPTURE));
		expect(await loadHarnessPrompt("claude-code")).not.toBeNull();
	}

	it("names the capture that replaced omp's base prompt", async () => {
		await serveCapture();

		const output = await runModelCommand(FABLE);

		expect(output).toContain(`${FABLE.provider}/${FABLE.id}`);
		expect(output).toContain("2.1.267.d7f");
		expect(output).toContain(path.join("claude-code", "2.1.267.d7f-cli.json"));
	});

	it("stays silent for a model that keeps omp's own prompt", async () => {
		await serveCapture();

		const output = await runModelCommand(SONNET);

		expect(output).toBe(`Current model: ${SONNET.provider}/${SONNET.id}`);
	});
});
