/**
 * `omp auth keys` — manage a provider's pooled API keys.
 *
 * Pooled keys serve alongside the provider's OAuth subscription accounts in the
 * order set by `auth.poolOrder`, and rotate when a key fails. Keys are read
 * from hidden terminal input or piped stdin, never from argv, and are only ever
 * displayed masked.
 */
import { DEFAULT_CREDENTIAL_POOL_ORDER, maskApiKey } from "@oh-my-pi/pi-ai";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { cfgAuthPoolOrder } from "../config/model-settings";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";

export const AUTH_KEYS_ACTIONS = ["add", "list", "remove"] as const;
export type AuthKeysAction = (typeof AUTH_KEYS_ACTIONS)[number];

export interface AuthKeysCommandArgs {
	action: AuthKeysAction;
	provider: string;
	/** Stored row id for `remove`. */
	id?: number;
	json?: boolean;
}

/**
 * Read one secret line: hidden keystrokes on a terminal, the first line of piped
 * stdin otherwise. Readline cannot read a line without echoing it, so the
 * terminal path reads raw bytes itself. Every exit (Enter, Ctrl-C, Escape, EOF,
 * stream error) runs one cleanup that restores the terminal's previous mode.
 */
async function readSecret(prompt: string): Promise<string> {
	const input = process.stdin;
	if (!input.isTTY || typeof input.setRawMode !== "function") {
		const text = await new Response(Bun.stdin.stream()).text();
		return text.split(/\r?\n/, 1)[0] ?? "";
	}
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const wasRaw = input.isRaw;
	const decoder = new TextDecoder();
	let answer = "";
	let settled = false;
	const settle = (done: () => void) => {
		if (settled) return;
		settled = true;
		input.off("data", onData);
		input.off("end", onClosed);
		input.off("close", onClosed);
		input.off("error", onError);
		// Restoring the terminal is best-effort: a dead TTY can throw or emit
		// `error` here, and neither may stop the promise from settling.
		const swallow = () => {};
		input.on("error", swallow);
		try {
			input.setRawMode(wasRaw);
			input.pause();
			process.stderr.write("\n");
		} catch {
			// The terminal is gone; nothing left to restore.
		} finally {
			input.off("error", swallow);
			done();
		}
	};
	const onClosed = () => settle(() => reject(new Error("stdin closed before a key was entered")));
	const onError = (error: Error) => settle(() => reject(error));
	const onData = (chunk: Buffer) => {
		for (const char of decoder.decode(chunk, { stream: true })) {
			if (char === "\r" || char === "\n") return settle(() => resolve(answer));
			if (char === "\u0003" || char === "\u001b") return settle(() => reject(new Error("cancelled")));
			if (char === "\u007f" || char === "\b") answer = answer.slice(0, -1);
			else if (char >= " ") answer += char;
		}
	};
	try {
		input.on("data", onData);
		input.once("end", onClosed);
		input.once("close", onClosed);
		input.once("error", onError);
		input.setRawMode(true);
		process.stderr.write(prompt);
		input.resume();
	} catch (error) {
		settle(() => reject(error));
	}
	return promise;
}

/**
 * Run one `omp auth keys` action. Failures print `auth keys failed: …` to stderr
 * and set exit code 1, matching `omp login`.
 */
export async function runAuthKeysCommand(args: AuthKeysCommandArgs): Promise<void> {
	const settings = await Settings.init();
	const storage = await discoverAuthStorage(undefined, { settings });
	const provider = args.provider;
	try {
		if (args.action === "add") {
			const key = (await readSecret(`API key for ${provider}: `)).trim();
			if (!key) throw new Error("no API key entered");
			const before = new Set(storage.credentials.pooledApiKeys(provider).map(row => row.id));
			const row = await storage.credentials.addApiKey(provider, key);
			const masked = maskApiKey(key);
			const total = storage.credentials.pooledApiKeys(provider).length;
			if (args.json) {
				process.stdout.write(
					`${JSON.stringify({ id: row.id, provider, key: masked, added: !before.has(row.id), total })}\n`,
				);
				return;
			}
			const verb = before.has(row.id) ? "already pooled" : "added";
			process.stdout.write(
				`${chalk.green("✓")} ${masked} ${verb} for ${provider} (id ${row.id}; ${total} pooled key${total === 1 ? "" : "s"}).\n`,
			);
			return;
		}

		if (args.action === "remove") {
			if (args.id === undefined) throw new Error(`usage: ${APP_NAME} auth keys remove <provider> <id>`);
			const row = storage.credentials.pooledApiKeys(provider).find(entry => entry.id === args.id);
			if (!row) {
				throw new Error(
					`no pooled API key with id ${args.id} for ${provider}; run \`${APP_NAME} auth keys list ${provider}\``,
				);
			}
			await storage.credentials.removeById(provider, row.id);
			const masked = maskApiKey(row.credential.key);
			if (args.json) {
				process.stdout.write(`${JSON.stringify({ id: row.id, provider, key: masked, removed: true })}\n`);
				return;
			}
			process.stdout.write(`${chalk.green("✓")} Removed ${masked} (id ${row.id}) from ${provider}.\n`);
			return;
		}

		const order = cfgAuthPoolOrder.get(settings)[provider] ?? DEFAULT_CREDENTIAL_POOL_ORDER;
		const pools = storage.limits.pools(provider);
		const keyPool = pools.find(pool => pool.kind === "api_key");
		const subscriptions = pools.find(pool => pool.kind === "oauth")?.members ?? 0;
		const keys = storage.credentials
			.pooledApiKeys(provider)
			.map(row => ({ id: row.id, key: maskApiKey(row.credential.key) }));
		if (args.json) {
			process.stdout.write(
				`${JSON.stringify({ provider, order, subscriptions, keys, blockedKeys: keyPool?.blocked ?? 0 })}\n`,
			);
			return;
		}
		process.stdout.write(
			`${chalk.bold(provider)}: ${order}; ${subscriptions} subscription account${subscriptions === 1 ? "" : "s"}, ${keys.length} pooled API key${keys.length === 1 ? "" : "s"}.\n`,
		);
		if (keys.length === 0) {
			process.stdout.write(chalk.dim(`Add one with \`${APP_NAME} auth keys add ${provider}\`.\n`));
			return;
		}
		for (const row of keys) process.stdout.write(`  ${chalk.dim(`id ${row.id}`)}  ${row.key}\n`);
		if (keyPool?.blocked) {
			process.stdout.write(
				chalk.yellow(`  ${keyPool.blocked} of ${keyPool.members} currently exhausted or failing.\n`),
			);
		}
	} catch (error) {
		process.stderr.write(chalk.red(`auth keys failed: ${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	} finally {
		storage.close();
	}
}
