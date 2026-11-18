/**
 * Regression: issue #9967.
 *
 * On a machine whose only real login is Anthropic OAuth but which also carries
 * an ambient AWS credential *source* (a stray `~/.aws` profile, an EC2 instance
 * role, static keys exported for unrelated tooling), `amazon-bedrock` passed the
 * default-model availability gate via the self-resolving `AUTHENTICATED_SENTINEL`
 * and — because its default model leads the bundled catalog order — won the
 * startup default over the provider the user actually signed into. The session
 * then 403'd on the first turn. The fix teaches auto-selection to prefer a
 * provider with a *concrete* credential over a sentinel-only ambient one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Every ambient AWS credential source Bedrock availability probes: env keys,
// the bypass flag, shared profile files, web identity, container and
// instance-role metadata. A host `~/.aws` profile must not make Bedrock available.
const AWS_ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_PROFILE",
	"AWS_SDK_LOAD_CONFIG",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT",
	"AWS_EC2_METADATA_DISABLED",
] as const;

describe("issue #9967 default model with ambient Bedrock credentials", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	const savedAwsEnv = new Map<string, string | undefined>();

	beforeEach(async () => {
		savedAwsEnv.clear();
		for (const key of AWS_ENV_KEYS) {
			savedAwsEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		tempDir = path.join(os.tmpdir(), `pi-9967-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(tempDir, "aws-credentials");
		process.env.AWS_CONFIG_FILE = path.join(tempDir, "aws-config");
		process.env.AWS_EC2_METADATA_DISABLED = "true";
		authStorage = createInMemoryAuthStorage();
		// The user's only real login: an Anthropic credential.
		await authStorage.credentials.set("anthropic", [{ type: "api_key", key: "sk-test-anthropic" }]);
		registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterEach(() => {
		authStorage.close();
		for (const [key, value] of savedAwsEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});
	function getRelevantModels() {
		return registry
			.getAvailable()
			.filter(model => model.provider === "amazon-bedrock" || model.provider === "anthropic");
	}

	test("prefers the concretely-authed provider over an ambient Bedrock default", () => {
		// Without any AWS credentials, Bedrock is not available and Anthropic wins.
		expect(authStorage.keys.source("amazon-bedrock") !== undefined).toBe(false);
		const baseline = pickDefaultAvailableModel(getRelevantModels(), provider => registry.hasConcreteAuth(provider));
		expect(baseline?.provider).toBe("anthropic");

		// Ambient AWS source with no usable Bedrock access (would 403 on request).
		process.env.AWS_ACCESS_KEY_ID = "AKIAJUNKJUNKJUNKJUNK";
		process.env.AWS_SECRET_ACCESS_KEY = "junksecretjunksecretjunksecretjunksecret";

		// The ambient source makes Bedrock *available* but not *concretely* authed.
		expect(authStorage.keys.source("amazon-bedrock") !== undefined).toBe(true);
		expect(registry.hasConcreteAuth("amazon-bedrock")).toBe(false);
		expect(registry.hasConcreteAuth("anthropic")).toBe(true);

		const available = getRelevantModels();
		const bedrockIdx = available.findIndex(model => model.provider === "amazon-bedrock");
		const anthropicIdx = available.findIndex(model => model.provider === "anthropic");
		// Catalog order leads with Bedrock — the ordering that produced the bug.
		expect(bedrockIdx).toBeGreaterThanOrEqual(0);
		expect(bedrockIdx).toBeLessThan(anthropicIdx);

		// Old behavior (no credential hint) regresses onto the unusable Bedrock default.
		expect(pickDefaultAvailableModel(available)?.provider).toBe("amazon-bedrock");

		// Fixed behavior: the provider the user signed into wins.
		const picked = pickDefaultAvailableModel(available, provider => registry.hasConcreteAuth(provider));
		expect(picked?.provider).toBe("anthropic");
		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.anthropic);
	});

	test("treats a dedicated Bedrock bearer token as concrete auth", () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-test-token";

		expect(authStorage.keys.source("amazon-bedrock") !== undefined).toBe(true);
		expect(registry.hasConcreteAuth("amazon-bedrock")).toBe(true);

		const picked = pickDefaultAvailableModel(getRelevantModels(), provider => registry.hasConcreteAuth(provider));
		expect(picked?.provider).toBe("amazon-bedrock");
	});
});
