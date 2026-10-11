import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { $env, $envExact, logger } from "@oh-my-pi/pi-utils";
import { type ApiKeyResolver, markAfterSiblingWait, type ResolvedApiKey } from "../auth-retry";
import * as AIError from "../error";
import { isUsageLimitOutcome } from "../error/rate-limit";
import { AUTHENTICATED_SENTINEL } from "../registry/types";
import { getEnvApiKey, getEnvApiKeyName } from "../stream";
import type { SessionAffinity } from "./affinity";
import type { CredentialBlocks } from "./blocks";
import { type AccountPolicies, isKeylessFallback, isPoolCredential } from "./policy";
import type { CredentialPool } from "./pool";
import type { CredentialSelector, OAuthResolutionResult } from "./select";
import type {
	ApiKeyCredential,
	AuthApiKeyOptions,
	AuthCredential,
	AuthSource,
	AuthSourceOptions,
	KeysApi,
	LimitsApi,
	OAuthRequestIdentity,
} from "./types";

/**
 * Default config value resolver that checks env vars and treats as literal.
 * Does NOT support "!command" syntax (that requires pi-natives).
 */
async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = $envExact(config);
	return envValue || config;
}

/** Runtime (--api-key) and config (models.yml) key overrides plus the config-value resolver. */
export class KeyOverrides {
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	#configFallbacks: Map<string, string> = new Map();
	#configValueResolver: (config: string) => Promise<string | undefined>;

	constructor(resolver?: (config: string) => Promise<string | undefined>) {
		this.#configValueResolver = resolver ?? defaultConfigValueResolver;
	}

	has(provider: string): boolean {
		return this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider);
	}

	runtimeKey(provider: string): string | undefined {
		return this.#runtimeOverrides.get(provider);
	}

	configKey(provider: string): string | undefined {
		return this.#configOverrides.get(provider);
	}

	/** Config value consulted only after stored OAuth/login credentials. */
	fallbackKey(provider: string): string | undefined {
		return this.#configFallbacks.get(provider);
	}

	/** Resolve a config value (env var name, "!command", literal) to the secret. */
	resolve(config: string): Promise<string | undefined> {
		return this.#configValueResolver(config);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntime(provider: string, apiKey: string): void {
		this.#runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntime(provider: string): void {
		this.#runtimeOverrides.delete(provider);
	}

	/**
	 * Register a per-provider API key sourced from user configuration
	 * (e.g. `models.yml` `providers.<name>.apiKey`). Higher priority than
	 * stored credentials and OAuth tokens — when the user pins a key in
	 * config, that key is what authenticates outbound requests, regardless
	 * of whatever the broker happens to have loaded for that provider.
	 *
	 * Lower priority than {@link KeyOverrides.setRuntime} so a CLI `--api-key`
	 * still wins for the duration of a single invocation.
	 *
	 * `fallback: true` instead ranks the value below stored OAuth and `/login`
	 * credentials (at the env-var tier). Providers that own a `/login` flow use
	 * this so their default key reference (e.g. an unset env-var name, which
	 * resolves to its literal text) cannot shadow the key the user logged in with.
	 */
	setConfig(provider: string, apiKeyConfig: string, options?: { fallback?: boolean }): void {
		if (options?.fallback) {
			this.#configOverrides.delete(provider);
			this.#configFallbacks.set(provider, apiKeyConfig);
		} else {
			this.#configFallbacks.delete(provider);
			this.#configOverrides.set(provider, apiKeyConfig);
		}
	}

	/**
	 * Remove a single config-sourced API key (override or fallback).
	 */
	removeConfig(provider: string): void {
		this.#configOverrides.delete(provider);
		this.#configFallbacks.delete(provider);
	}

	/**
	 * Drop every config-sourced API key. Called by `ModelRegistry` before
	 * re-parsing `models.yml` so removed entries actually disappear.
	 */
	clearConfig(): void {
		this.#configOverrides.clear();
		this.#configFallbacks.clear();
	}

	/**
	 * Install the host's async config-value resolver. Coding-agent uses this so
	 * every stored/config credential reference shares command caching,
	 * failure backoff, and process hardening even when AuthStorage was created
	 * independently and later attached to a registry.
	 */
	setResolver(resolver: (config: string) => Promise<string | undefined>): void {
		this.#configValueResolver = resolver;
	}
}

/** One of a provider's two stored credential pools. */
type CredentialPoolKind = AuthCredential["type"];

/** Dependencies of the provider key precedence cascade. */
export interface KeyCascadeDeps {
	pool: CredentialPool;
	overrides: KeyOverrides;
	selector: CredentialSelector;
	affinity: SessionAffinity;
	blocks: CredentialBlocks;
	policies: AccountPolicies;
	/** LimitsApi.rotate, injected to avoid a cascade↔rotation import cycle. */
	rotate: LimitsApi["rotate"];
	sourceLabel?: string;
}

/** The provider auth precedence cascade (runtime → config → OAuth → login key → env → stored key). */
export class KeyCascade implements KeysApi {
	#deps: KeyCascadeDeps;

	constructor(deps: KeyCascadeDeps) {
		this.#deps = deps;
	}

	/** Stored credentials that carry real auth — keyless-fallback markers excluded. */
	#getAuthBearingCredentials(provider: string): AuthCredential[] {
		return this.#deps.pool.credentials(provider).filter(credential => !isKeylessFallback(provider, credential));
	}

	/**
	 * True when the provider has stored credentials but none of them carries
	 * auth — i.e. its only credential is the KDL `empty-fallback` keyless-mode
	 * marker (an empty paste at an optional-key login prompt). Such a provider
	 * is configured-but-keyless: model availability treats it like an
	 * `auth: none` endpoint instead of locking it out (issue #12281).
	 */
	keyless(provider: string): boolean {
		const stored = this.#deps.pool.credentials(provider);
		return stored.length > 0 && stored.every(credential => isKeylessFallback(provider, credential));
	}

	/**
	 * Env auth that belongs to this provider, not a cross-provider alias.
	 * A declared OAuth token env list excludes borrowed API-key aliases from
	 * availability and origin, while explicit streams may still use those keys.
	 */
	#hasDedicatedEnvAuth(provider: string): boolean {
		const oauthTokenEnv = authPolicyFor(provider)?.oauthTokenEnv;
		if (oauthTokenEnv) return oauthTokenEnv.some(name => Boolean($env[name]?.trim()));
		return Boolean(getEnvApiKey(provider));
	}

	/**
	 * Classify where a provider's auth comes from, following the same precedence
	 * as {@link KeyCascade.get}: runtime override → config override → stored
	 * OAuth and pooled API keys (in the configured pool order) → config fallback →
	 * env var → other stored api_key. Returns undefined when no auth is configured.
	 *
	 * Compact, structured counterpart to {@link KeyCascade.describe}; `env`
	 * selects dedicated-only, alias-aware, or no environment fallback.
	 */
	source(provider: string, { env = "dedicated" }: AuthSourceOptions = {}): AuthSource | undefined {
		if (this.#deps.overrides.runtimeKey(provider) !== undefined) return { kind: "runtime", concrete: true };
		if (this.#deps.overrides.configKey(provider) !== undefined) return { kind: "config", concrete: true };
		const bearing = this.#getAuthBearingCredentials(provider);
		const concrete = bearing.length > 0 || this.#envConcrete(provider);
		for (const pool of this.#deps.policies.poolOrder(provider)) {
			const present =
				pool === "oauth"
					? bearing.some(credential => credential.type === "oauth")
					: bearing.some(credential => this.isPooledApiKey(provider, credential));
			if (present) return { kind: pool, concrete: true };
		}
		if (this.#deps.overrides.fallbackKey(provider) !== undefined) return { kind: "config", concrete: true };
		if (
			(env === "dedicated" && this.#hasDedicatedEnvAuth(provider)) ||
			(env === "aliases" && (this.#hasDedicatedEnvAuth(provider) || Boolean(getEnvApiKey(provider))))
		) {
			return { kind: "env", envVar: getEnvApiKeyName(provider), concrete };
		}
		if (bearing.some(credential => credential.type === "api_key")) return { kind: "api_key", concrete: true };
		return undefined;
	}

	/** Check if a provider has a concrete env token, excluding ambient sentinel auth. */
	#envConcrete(provider: string): boolean {
		// Bedrock's bearer is transport-specific rather than an auth-stratum OAuth token.
		if ((provider === "amazon-bedrock" || provider === "bedrock-mantle") && $env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
			return true;
		}
		const oauthTokenEnv = authPolicyFor(provider)?.oauthTokenEnv;
		if (oauthTokenEnv) return oauthTokenEnv.some(name => Boolean($env[name]?.trim()));
		const envApiKey = getEnvApiKey(provider);
		return envApiKey !== undefined && envApiKey !== AUTHENTICATED_SENTINEL;
	}

	/**
	 * Peek at API key for a provider without refreshing OAuth tokens.
	 * Used for model discovery where we only need to know if credentials exist
	 * and get a best-effort token. GitHub Copilot's peek must preserve
	 * enterprise routing metadata because discovery needs a structured
	 * credential to reach the correct host.
	 */
	async peek(provider: string): Promise<string | undefined> {
		const runtimeKey = this.#deps.overrides.runtimeKey(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#deps.overrides.configKey(provider);
		if (configKey !== undefined) {
			return await this.#deps.overrides.resolve(configKey);
		}

		await this.#deps.pool.adoptExternalChanges();

		// Stored pools in the configured order, then an explicit env var, then a
		// stored static api_key (which may be a stale broker-migrated copy) as a last resort.
		for (const pool of this.#deps.policies.poolOrder(provider)) {
			if (pool === "api_key") {
				const pooledKey = this.#deps.selector.selectByType(provider, "api_key", undefined, credential =>
					this.isPooledApiKey(provider, credential),
				);
				if (pooledKey) return this.#deps.overrides.resolve(pooledKey.credential.key);
				continue;
			}
			const oauthSelection = this.#deps.selector.selectByType(provider, "oauth");
			if (!oauthSelection) continue;
			const expiresAt = oauthSelection.credential.expires;
			if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue;
			if (provider === "github-copilot") {
				return JSON.stringify({
					token: oauthSelection.credential.access,
					enterpriseUrl: oauthSelection.credential.enterpriseUrl,
					apiEndpoint: oauthSelection.credential.apiEndpoint,
				});
			}
			return oauthSelection.credential.access;
		}

		const fallbackKey = this.#deps.overrides.fallbackKey(provider);
		if (fallbackKey !== undefined) return this.#deps.overrides.resolve(fallbackKey);

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		const apiKeySelection = this.#deps.selector.selectByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#deps.overrides.resolve(apiKeySelection.credential.key);
		}
		return undefined;
	}

	/** Resolve a bearer together with the stored row that supplied it. */
	async getWithCredential(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		let credentialId: number | undefined;
		let oauthIdentity: OAuthRequestIdentity | undefined;
		const apiKey = await this.#resolve(provider, sessionId, options, (id, identity) => {
			credentialId = id;
			oauthIdentity = identity;
		});
		return apiKey === undefined ? undefined : { apiKey, credentialId, ...(oauthIdentity ? { oauthIdentity } : {}) };
	}

	/**
	 * Get API key for a provider.
	 * Priority (first match wins): runtime override, config override, OAuth,
	 * login API key, environment variable, then another stored API key.
	 */
	async get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		try {
			return await this.#resolve(provider, sessionId, options);
		} catch (error) {
			if (!(error instanceof AIError.OAuthRefreshUnavailableError)) throw error;
			logger.debug("API key probe skipped transient OAuth refresh failure", { provider, error: error.message });
			return undefined;
		}
	}

	async #resolve(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
		onCredentialId?: (id: number, identity?: OAuthRequestIdentity) => void,
	): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.#deps.overrides.runtimeKey(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		// Config override: explicit apiKey pinned in models.yml beats the broker's
		// OAuth credentials. The user redirected a provider at a custom baseUrl
		// (e.g. an auth-gateway) and supplied the bearer for that endpoint —
		// honor it instead of forwarding an upstream OAuth token that the proxy
		// won't accept.
		const configKey = this.#deps.overrides.configKey(provider);
		if (configKey !== undefined) {
			return this.#deps.overrides.resolve(configKey);
		}

		const stored = await this.#resolveStoredPools(provider, sessionId, options, onCredentialId);
		if (stored.apiKey !== undefined) return stored.apiKey;
		if (stored.admitted) return undefined;
		const oauthRefreshFailure = stored.oauthRefreshFailure;

		// Past OAuth: the session sticky (if any) is stale — the request authenticates via
		// env/api_key, not OAuth, so clear it now so getOAuthAccountId() correctly
		// suppresses account_uuid for this session.
		if (sessionId) this.#deps.affinity.forget(provider, sessionId);

		const fallbackKey = this.#deps.overrides.fallbackKey(provider);
		if (fallbackKey !== undefined) return this.#deps.overrides.resolve(fallbackKey);

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;
		const storedApiKey = await this.#resolveStoredApiKey(
			provider,
			sessionId,
			options,
			credential => credential.source !== "login",
		);
		if (storedApiKey) {
			if (storedApiKey.apiKey !== undefined) onCredentialId?.(storedApiKey.credentialId);
			return storedApiKey.apiKey;
		}
		if (oauthRefreshFailure) throw oauthRefreshFailure;
		return undefined;
	}

	/**
	 * Resolve the provider's two stored pools: OAuth subscription accounts and
	 * pooled API keys (`/login` or `omp auth keys add` keys). The configured
	 * {@link CredentialPoolOrder} picks which serves first. A pool is skipped while
	 * every member is blocked, so an exhausted pool falls through to the other one.
	 * When both pools are unusable, the preferred pool's last resort still returns
	 * a credential, so the caller sees the provider's real error instead of a
	 * missing key.
	 */
	async #resolveStoredPools(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		onCredentialId: ((id: number, identity?: OAuthRequestIdentity) => void) | undefined,
	): Promise<{
		apiKey?: string;
		admitted?: boolean;
		oauthRefreshFailure?: AIError.OAuthRefreshUnavailableError;
	}> {
		// Another process may have added or removed credentials; the pool check
		// must see them, or a provider whose only account arrived externally reads empty.
		await this.#deps.pool.adoptExternalChanges();
		const stored = this.#deps.pool.credentials(provider);
		const hasOAuth = stored.some(credential => credential.type === "oauth");
		const hasPooledKeys = stored.some(credential => this.isPooledApiKey(provider, credential));
		const available = this.#deps.policies
			.poolOrder(provider)
			.filter(pool => (pool === "oauth" ? hasOAuth : hasPooledKeys));
		let oauthRefreshFailure: AIError.OAuthRefreshUnavailableError | undefined;
		const tryPool = async (pool: CredentialPoolKind, strict: boolean) => {
			if (pool === "api_key") {
				return this.#resolveStoredApiKey(
					provider,
					sessionId,
					options,
					credential => this.isPooledApiKey(provider, credential),
					strict,
				);
			}
			let resolved: OAuthResolutionResult | undefined;
			try {
				resolved = await this.#deps.selector.resolveOAuth(provider, sessionId, options, strict);
			} catch (error) {
				if (!(error instanceof AIError.OAuthRefreshUnavailableError)) throw error;
				oauthRefreshFailure = error;
				return undefined;
			}
			if (!resolved) return undefined;
			const { orgId, region, inferenceRegion } = resolved.credential;
			return {
				apiKey: resolved.apiKey,
				credentialId: resolved.credentialId,
				identity: { orgId, region, inferenceRegion },
			};
		};
		// One pool: its own selection ladder (strict, then last resort) is the whole story.
		// Two pools: each strictly in order, then the preferred pool's last resort.
		const [preferred, ...rest] = available;
		const passes: Array<[CredentialPoolKind, boolean]> =
			preferred === undefined
				? []
				: rest.length === 0
					? [[preferred, false]]
					: [
							[preferred, true],
							...rest.map((pool): [CredentialPoolKind, boolean] => [pool, true]),
							[preferred, false],
						];
		for (const [pool, strict] of passes) {
			const resolved = await tryPool(pool, strict);
			if (!resolved) continue;
			if (resolved.apiKey !== undefined && resolved.credentialId !== undefined) {
				onCredentialId?.(resolved.credentialId, "identity" in resolved ? resolved.identity : undefined);
			}
			// An admitted key whose reference failed to resolve must not enable a lower-precedence source.
			return { apiKey: resolved.apiKey, admitted: true, oauthRefreshFailure };
		}
		return { oauthRefreshFailure };
	}

	/** A stored API key in the provider's key pool (not a migrated copy or a keyless-mode marker). */
	isPooledApiKey(provider: string, credential: AuthCredential): credential is ApiKeyCredential {
		return credential.type === "api_key" && isPoolCredential(provider, credential);
	}

	async #resolveStoredApiKey(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter: (credential: ApiKeyCredential) => boolean,
		strict = false,
	): Promise<{ apiKey: string | undefined; credentialId: number } | undefined> {
		const selection = await this.#deps.selector.selectApiKey(provider, sessionId, options, filter, strict);
		if (!selection) return undefined;
		let apiKey = await this.#deps.overrides.resolve(selection.credential.key);
		if (!this.#deps.selector.syncApiKeySelection(provider, selection, filter)) apiKey = undefined;
		if (apiKey !== undefined) {
			const recorded = this.#deps.affinity.record(provider, sessionId, "api_key", selection.index);
			if (sessionId && !recorded) apiKey = undefined;
		}
		// An admitted but unresolved source must not silently enable a lower-precedence key.
		return { apiKey, credentialId: selection.credentialId };
	}

	/**
	 * Build an {@link ApiKeyResolver} backed by this storage, implementing the
	 * central a/b/c auth-retry policy:
	 *
	 * - initial (`error: undefined`) → resolve the session credential.
	 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential.
	 * - step (c) `lastChance` → rotate to a sibling and re-resolve, unless quota exhaustion has no sibling.
	 *
	 * Used by web-search providers and other consumers that hold a KeyCascade
	 * directly (no ModelRegistry in scope).
	 */
	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		const { sessionId, baseUrl, modelId } = options ?? {};
		return async ({ lastChance, error, signal, previousKey }) => {
			if (error === undefined) {
				return this.getWithCredential(provider, sessionId, {
					baseUrl,
					modelId,
					signal,
				});
			}
			if (lastChance) {
				const rotation = await this.#deps.rotate(provider, sessionId, {
					error,
					modelId,
					signal,
					apiKey: previousKey,
				});
				if (!rotation.switched) {
					const status = AIError.status(error);
					const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
					// Preserve no-sibling quota backoff instead of re-resolving an
					// already-blocked fallback. Hard-auth declines still re-resolve
					// because a peer may have refreshed the failed bearer.
					if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) return undefined;
				}
				const resolved = await this.getWithCredential(provider, sessionId, {
					baseUrl,
					modelId,
					signal,
				});
				return rotation.afterSiblingWait ? markAfterSiblingWait(resolved) : resolved;
			}
			return this.getWithCredential(provider, sessionId, {
				baseUrl,
				modelId,
				forceRefresh: true,
				refreshReason: AIError.status(error) === 401 ? "auth-recovery" : undefined,
				signal,
			});
		};
	}

	/**
	 * Describe where the active credential for a provider came from.
	 *
	 * Mirrors {@link KeyCascade.get} precedence, highest first:
	 *   1. Runtime override (`--api-key`).
	 *   2. Config override (`models.yml` `providers.<name>.apiKey`).
	 *   3–4. The stored pools in `auth.poolOrder`: OAuth accounts (never one on
	 *        hold) and pooled API keys; subscription-first by default.
	 *   5. Env var — overrides a stored static api_key (e.g. a stale broker copy).
	 *   6. Stored static api_key credential.
	 *
	 * The string is purely informational; consumers must not parse it.
	 */
	describe(provider: string, sessionId?: string): string | undefined {
		if (this.#deps.overrides.runtimeKey(provider) !== undefined) {
			return "runtime override (--api-key)";
		}
		if (this.#deps.overrides.configKey(provider) !== undefined) {
			return "config override (models.yml)";
		}

		const baseLabel = this.#deps.sourceLabel ?? "local store";
		const stored = this.#deps.pool.entries(provider);
		const session = this.#deps.affinity.get(provider, sessionId);
		const describeStored = (
			type: AuthCredential["type"],
			filter?: (credential: AuthCredential) => boolean,
		): string | undefined => {
			// A held account is neither the session's credential nor its fallback.
			const typed = stored
				.map((entry, index) => ({ entry, index }))
				.filter(
					({ entry, index }) =>
						entry.credential.type === type &&
						!this.#deps.blocks.isHeld(provider, index) &&
						(filter?.(entry.credential) ?? true),
				);
			if (typed.length === 0) return undefined;
			const sticky = session?.type === type ? typed.find(entry => entry.index === session.index) : undefined;
			const chosen = sticky?.entry ?? typed[0].entry;
			const credential = chosen.credential;
			const identity =
				credential.type === "oauth"
					? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${chosen.id}`)
					: `cred ${chosen.id}`;
			return `${baseLabel} · ${type} #${chosen.id} (${identity})`;
		};

		// Stored pools in the configured order; then an explicit env var; then a stored static api_key.
		for (const pool of this.#deps.policies.poolOrder(provider)) {
			const source =
				pool === "oauth"
					? describeStored("oauth")
					: describeStored("api_key", credential => this.isPooledApiKey(provider, credential));
			if (source) return source;
		}
		if (this.#deps.overrides.fallbackKey(provider) !== undefined) return "provider config (fallback)";
		if (getEnvApiKey(provider)) return `env (over ${baseLabel})`;
		const apiKeySource = describeStored(
			"api_key",
			credential => credential.type !== "api_key" || credential.source !== "login",
		);
		if (apiKeySource) return apiKeySource;
		return undefined;
	}

	setRuntime(provider: string, apiKey: string): void {
		this.#deps.overrides.setRuntime(provider, apiKey);
	}

	removeRuntime(provider: string): void {
		this.#deps.overrides.removeRuntime(provider);
	}

	setConfig(provider: string, apiKeyConfig: string, options?: { fallback?: boolean }): void {
		this.#deps.overrides.setConfig(provider, apiKeyConfig, options);
	}

	removeConfig(provider: string): void {
		this.#deps.overrides.removeConfig(provider);
	}

	clearConfig(): void {
		this.#deps.overrides.clearConfig();
	}

	setResolver(resolver: (config: string) => Promise<string | undefined>): void {
		this.#deps.overrides.setResolver(resolver);
	}
}
