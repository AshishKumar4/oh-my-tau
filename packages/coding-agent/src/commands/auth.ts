/**
 * `omp auth` — provider credentials.
 *
 * `omp auth keys <add|list|remove> <provider> [id]` manages pooled API keys.
 *
 * `omp auth export` prints every active credential in the local credential
 * store (`agent.db`) as JSON — API keys and OAuth logins, refresh tokens
 * included. `omp auth import <file>` merges such a file into the local store:
 * an imported OAuth login replaces the stored login of the same provider
 * account, an imported pooled API key replaces the same pooled key, an
 * imported static API key replaces the provider's static key, and everything
 * else is kept.
 */
import { type } from "@oh-my-pi/omptype";
import {
	type AuthCredential,
	type AuthCredentialStore,
	isSameOAuthAccount,
	matchesReplacementCredential,
	resolveCredentialIdentityKey,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { writableAuthCredentialSchema } from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";
import { APP_NAME, getAgentDbPath, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { AUTH_KEYS_ACTIONS, runAuthKeysCommand } from "../cli/auth-keys-cli";
import { authHelp as commandHelp } from "../cli/command-help";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";

/** Format version of the `omp auth export` document. */
export const AUTH_EXPORT_VERSION = 1;

/** One stored credential in an `omp auth export` document. */
export interface AuthExportEntry {
	/** Provider id the credential authenticates (e.g. `anthropic`). */
	provider: string;
	/** The credential exactly as stored, OAuth refresh token included. */
	credential: AuthCredential;
}

/** The document `omp auth export` prints and `omp auth import` reads. */
export interface AuthExport {
	version: typeof AUTH_EXPORT_VERSION;
	credentials: AuthExportEntry[];
}

/** Result of {@link importAuthCredentials}. */
export interface AuthImportSummary {
	/** Number of credentials written. */
	imported: number;
	/** Providers that received credentials, in first-seen order. */
	providers: string[];
}

/** A malformed or unsupported credential export. */
export class AuthTransferError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthTransferError";
	}
}

/** Every active credential in `store`, in storage order. */
export function exportAuthCredentials(store: Pick<AuthCredentialStore, "listAuthCredentials">): AuthExport {
	return {
		version: AUTH_EXPORT_VERSION,
		credentials: store.listAuthCredentials().map(row => ({ provider: row.provider, credential: row.credential })),
	};
}

/**
 * One credential of an export, validated by the schema the auth broker applies
 * to credential uploads: a writable API key or OAuth login (never a broker
 * snapshot's refresh sentinel), with its provider-specific fields kept.
 */
function parseCredential(value: unknown, where: string): AuthCredential {
	const credential = writableAuthCredentialSchema(value);
	if (credential instanceof type.errors) throw new AuthTransferError(`${where}: ${credential.summary}`);
	return credential;
}

/**
 * Parse and validate an `omp auth export` document. Throws
 * {@link AuthTransferError} naming the first offending entry.
 */
export function parseAuthExport(text: string, source = "credential file"): AuthExport {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new AuthTransferError(`${source} is not valid JSON.`);
	}
	if (!isRecord(value)) throw new AuthTransferError(`${source} is not an \`omp auth export\` document.`);
	if (value.version !== AUTH_EXPORT_VERSION) {
		throw new AuthTransferError(
			`${source} has export version ${JSON.stringify(value.version)}; this omp reads version ${AUTH_EXPORT_VERSION}.`,
		);
	}
	if (!Array.isArray(value.credentials)) throw new AuthTransferError(`${source} has no credentials array.`);
	const credentials = value.credentials.map((entry: unknown, index): AuthExportEntry => {
		const where = `${source}: credentials[${index}]`;
		if (!isRecord(entry) || typeof entry.provider !== "string" || entry.provider.length === 0) {
			throw new AuthTransferError(`${where} has no provider.`);
		}
		return {
			provider: entry.provider,
			credential: parseCredential(entry.credential, `${where} (${entry.provider})`),
		};
	});
	return { version: AUTH_EXPORT_VERSION, credentials };
}

/**
 * Whether importing `incoming` for `provider` replaces the stored `existing`
 * credential. Pooled API keys rotate together, so a pooled key replaces only
 * the same key; a static API key replaces the provider's static key; an OAuth
 * login replaces the stored login of the same account.
 */
function replacesCredential(provider: string, existing: AuthCredential, incoming: AuthCredential): boolean {
	if (incoming.type === "api_key") {
		if (existing.type !== "api_key") return false;
		return existing.source === "login" || incoming.source === "login" ? existing.key === incoming.key : true;
	}
	if (existing.type !== "oauth") return false;
	return (
		matchesReplacementCredential(provider, existing, resolveCredentialIdentityKey(provider, existing), incoming) ||
		isSameOAuthAccount(existing, incoming)
	);
}

/**
 * Merge `data` into `store`, one provider at a time: stored credentials that
 * an imported one replaces (same provider and account) are swapped for it,
 * all others are kept. Each provider is written in one store transaction.
 */
export async function importAuthCredentials(
	store: Pick<AuthCredentialStore, "listAuthCredentials" | "replaceAuthCredentials">,
	data: AuthExport,
): Promise<AuthImportSummary> {
	const byProvider = new Map<string, AuthCredential[]>();
	for (const { provider, credential } of data.credentials) {
		const list = byProvider.get(provider);
		if (list) list.push(credential);
		else byProvider.set(provider, [credential]);
	}
	for (const [provider, incoming] of byProvider) {
		let merged = store.listAuthCredentials(provider).map(row => row.credential);
		for (const credential of incoming) {
			merged = merged.filter(existing => !replacesCredential(provider, existing, credential));
			merged.push(credential);
		}
		await store.replaceAuthCredentials(provider, merged);
	}
	return { imported: data.credentials.length, providers: [...byProvider.keys()] };
}

export default class Auth extends Command {
	static description = commandHelp.description;

	static args = {
		command: Args.string({
			description: "keys, export, or import",
			required: true,
			options: ["keys", "export", "import"],
		}),
		action: Args.string({
			description: "keys: add, list, or remove; import: file written by `omp auth export`, or - for stdin",
			required: false,
		}),
		provider: Args.string({ description: "keys: provider id (e.g. anthropic)", required: false }),
		id: Args.string({ description: "keys remove: stored key id", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (keys)" }),
		workspace: Flags.string({
			description: "Anthropic workspace ID for a key not scoped to one (keys add; asked for when omitted)",
		}),
	};

	static examples = [
		`# Add a key to the anthropic pool (hidden prompt; or pipe it on stdin)\n  ${APP_NAME} auth keys add anthropic`,
		`# Add a key that is not scoped to a workspace, naming the workspace its requests use\n  ${APP_NAME} auth keys add anthropic --workspace wrkspc_01Jw…`,
		`# List pooled keys (masked) and the serving order\n  ${APP_NAME} auth keys list anthropic`,
		`# Remove a pooled key by its id\n  ${APP_NAME} auth keys remove anthropic 12`,
		`# Serve pooled API keys before subscriptions\n  ${APP_NAME} config set auth.poolOrder '{"anthropic":"api-keys-first"}'`,
		`# Write every stored credential to a file (keep it secret)\n  ${APP_NAME} auth export > credentials.json`,
		`# Merge them into this machine's credential store\n  ${APP_NAME} auth import credentials.json`,
		`# Copy credentials to another machine over SSH\n  ${APP_NAME} auth export | ssh host ${APP_NAME} auth import -`,
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Auth);
		if (args.command === "keys") {
			const action = AUTH_KEYS_ACTIONS.find(candidate => candidate === args.action);
			if (!action) {
				throw new CliUsageError(`Usage: ${APP_NAME} auth keys <${AUTH_KEYS_ACTIONS.join("|")}> <provider> [id]`);
			}
			if (!args.provider) throw new CliUsageError(`Usage: ${APP_NAME} auth keys ${action} <provider>`);
			let id: number | undefined;
			if (args.id !== undefined) {
				id = Number(args.id);
				if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid key id '${args.id}'`);
			}
			await runAuthKeysCommand({
				action,
				provider: args.provider,
				id,
				workspace: flags.workspace,
				json: flags.json,
			});
			return;
		}
		await runAuthTransfer(args.command === "export" ? "export" : "import", args.action, argv);
	}
}

/** `omp auth export` / `omp auth import <file|->` against the local credential store. */
async function runAuthTransfer(
	action: "export" | "import",
	fileArg: string | undefined,
	argv: readonly string[],
): Promise<void> {
	if (action === "export" && argv.length > 1) {
		throw new CliUsageError(`Unexpected argument "${argv[1]}". Usage: ${APP_NAME} auth export`);
	}
	if (action === "import" && !fileArg) {
		throw new CliUsageError(`Missing credential file. Usage: ${APP_NAME} auth import <file|->`);
	}
	if (action === "import" && argv.length > 2) {
		throw new CliUsageError(`Unexpected argument "${argv[2]}". Usage: ${APP_NAME} auth import <file|->`);
	}
	const broker = await resolveAuthBrokerConfig();
	if (broker) {
		process.stderr.write(
			`${chalk.red(`error: omp uses the auth broker at ${broker.url}; credentials live there, not in this machine's agent.db.`)}\n` +
				"Run this on the broker host, or disable the broker (`omp config reset auth.broker.url`) first.\n",
		);
		process.exitCode = 1;
		return;
	}

	if (action === "export") {
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		let data: AuthExport;
		try {
			data = exportAuthCredentials(store);
		} finally {
			store.close();
		}
		const oauthCount = data.credentials.filter(entry => entry.credential.type === "oauth").length;
		if (oauthCount > 0) {
			process.stderr.write(
				`${chalk.yellow(`warning: this output holds live secrets, including ${oauthCount} OAuth refresh token(s). Providers that rotate refresh tokens on use accept only the newest one: once the importing machine refreshes, this machine may be signed out of those accounts.`)}\n`,
			);
		}
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}

	const file = fileArg ?? "";
	let text: string;
	try {
		text = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		process.stderr.write(`${chalk.red(`error: credential file not found: ${file}`)}\n`);
		process.exitCode = 1;
		return;
	}
	let data: AuthExport;
	try {
		data = parseAuthExport(text, file === "-" ? "stdin" : file);
	} catch (error) {
		if (!(error instanceof AuthTransferError)) throw error;
		process.stderr.write(`${chalk.red(`error: ${error.message}`)}\n`);
		process.exitCode = 1;
		return;
	}
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		const summary = await importAuthCredentials(store, data);
		process.stderr.write(
			summary.imported === 0
				? "No credentials to import.\n"
				: `Imported ${summary.imported} credential(s) for ${summary.providers.join(", ")}.\n`,
		);
	} finally {
		store.close();
	}
}
