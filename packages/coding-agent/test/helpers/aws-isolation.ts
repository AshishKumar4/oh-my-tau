import * as path from "node:path";

// Every ambient AWS credential source Bedrock availability probes: env keys,
// the bypass flag, shared profile files, web identity, container and
// instance-role metadata (same set as default-model-ambient-bedrock.test.ts).
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

/**
 * Hide the host's AWS credential sources so a `~/.aws` profile cannot make
 * Bedrock available: clears every probed variable, points the shared files at
 * missing paths under `dir`, and disables EC2 metadata. Returns the restore.
 */
export function isolateAwsCredentialSources(dir: string): () => void {
	const saved = new Map<string, string | undefined>();
	for (const key of AWS_ENV_KEYS) {
		saved.set(key, process.env[key]);
		delete process.env[key];
	}
	process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, "aws-credentials");
	process.env.AWS_CONFIG_FILE = path.join(dir, "aws-config");
	process.env.AWS_EC2_METADATA_DISABLED = "true";
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}
