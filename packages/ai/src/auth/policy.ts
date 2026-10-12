import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import * as AIError from "../error";
import type {
	AuthAccountPolicies,
	AuthAccountPolicy,
	AuthAccountSelector,
	AuthCredential,
	CredentialPoolOrders,
	OAuthAccountIdentity,
	OAuthCredential,
} from "./types";
import { DEFAULT_CREDENTIAL_POOL_ORDER, DEFAULT_USAGE_RESERVE_PCT } from "./types";

/** Whether every identity field set on `selector` matches `identity`. */
export function matchesAuthAccountSelector(selector: AuthAccountSelector, identity: OAuthAccountIdentity): boolean {
	return (
		(selector.email === undefined || selector.email === identity.email) &&
		(selector.accountId === undefined || selector.accountId === identity.accountId) &&
		(selector.projectId === undefined || selector.projectId === identity.projectId) &&
		(selector.orgId === undefined || selector.orgId === identity.orgId)
	);
}

/**
 * True when a stored credential is the provider's KDL `empty-fallback`
 * keyless-mode marker — what an empty paste at an "Optional: paste API key"
 * login prompt stores (e.g. `lm-studio-local` for lm-studio). The wire layer
 * never sends these as a bearer (`isDiscoveryBearerApiKey` strips them), so
 * auth-status surfaces must not count them either; otherwise the model hub
 * and `/login` report the provider as authenticated while every request
 * goes out bare (issue #12281). The credential itself stays stored: `/logout`
 * can still remove it, and availability treats the provider as keyless.
 */
export function isKeylessFallback(provider: string, credential: AuthCredential): boolean {
	if (credential.type !== "api_key") return false;
	const login = authPolicyFor(provider)?.login;
	if (login?.kind !== "api-key") return false;
	const fallback = login.emptyFallback;
	return fallback !== undefined && fallback !== "" && credential.key === fallback;
}

/**
 * Whether a stored credential belongs to one of the provider's two rotating
 * pools: an OAuth subscription account, or a pooled API key (`source: "login"`).
 * Legacy and broker-migrated static keys and keyless-mode markers are outside both pools.
 */
export function isPoolCredential(provider: string, credential: AuthCredential): boolean {
	if (credential.type === "oauth") return true;
	return credential.source === "login" && !isKeylessFallback(provider, credential);
}

/**
 * The model's OAuth account entitlement filter (`AuthApiKeyOptions.accountIds`).
 * Applies only when at least one stored OAuth account is entitled; otherwise
 * (no entitlements, or none stored) every account stays eligible. Strict
 * selection and rotation both use it, so rotation counts exactly the accounts
 * selection will accept.
 */
export function oauthEntitlementFilter(
	credentials: readonly AuthCredential[],
	accountIds: readonly string[] | undefined,
): ((credential: OAuthCredential) => boolean) | undefined {
	if (!accountIds?.length) return undefined;
	const entitled = new Set(accountIds);
	const isEntitled = (credential: OAuthCredential): boolean =>
		credential.accountId !== undefined && entitled.has(credential.accountId);
	const anyEntitled = credentials.some(credential => credential.type === "oauth" && isEntitled(credential));
	return anyEntitled ? isEntitled : undefined;
}

/**
 * Validated per-account routing policies (priority/reserve), the global reserve
 * fallback, and each provider's stored-pool order.
 */
export class AccountPolicies {
	#accountPolicies: AuthAccountPolicies;
	#defaultReservePct: number;
	#poolOrders: CredentialPoolOrders;

	constructor(
		policies: AuthAccountPolicies,
		defaultReservePct: number | undefined,
		poolOrders: CredentialPoolOrders = {},
	) {
		AccountPolicies.#validateAccountPolicyConfiguration(policies);
		this.#accountPolicies = policies;
		this.#defaultReservePct =
			typeof defaultReservePct === "number" && Number.isFinite(defaultReservePct)
				? Math.max(0, Math.min(100, defaultReservePct))
				: DEFAULT_USAGE_RESERVE_PCT;
		this.#poolOrders = poolOrders;
	}

	/** Global usage reserve (0–100) for accounts without a per-account `reservePct`. */
	get defaultReservePct(): number {
		return this.#defaultReservePct;
	}

	/** The provider's stored pools in serving order; {@link DEFAULT_CREDENTIAL_POOL_ORDER} unless configured. */
	poolOrder(provider: string): readonly AuthCredential["type"][] {
		return (this.#poolOrders[provider] ?? DEFAULT_CREDENTIAL_POOL_ORDER) === "api-keys-first"
			? ["api_key", "oauth"]
			: ["oauth", "api_key"];
	}

	/**
	 * Replace the policy set, global reserve, and pool orders in place (live
	 * settings change). Validates the configuration and every provider in
	 * `storedCredentials` before committing; on error the previous policies stay active.
	 */
	replace(
		policies: AuthAccountPolicies,
		defaultReservePct: number | undefined,
		poolOrders: CredentialPoolOrders,
		storedCredentials: ReadonlyMap<string, readonly AuthCredential[]> = new Map(),
	): void {
		const next = new AccountPolicies(policies, defaultReservePct, poolOrders);
		for (const [provider, credentials] of storedCredentials) next.validateFor(provider, credentials);
		this.#accountPolicies = next.#accountPolicies;
		this.#defaultReservePct = next.#defaultReservePct;
		this.#poolOrders = next.#poolOrders;
	}

	static #validateAccountPolicyConfiguration(accountPolicies: AuthAccountPolicies): void {
		for (let index = 0; index < accountPolicies.length; index += 1) {
			const policy = accountPolicies[index]!;
			const path = `auth.accountPolicies[${index}]`;
			if (
				typeof policy.provider !== "string" ||
				policy.provider.length === 0 ||
				policy.provider.trim() !== policy.provider
			) {
				throw new AIError.ConfigurationError(
					`${path}.provider must be a non-empty string without surrounding whitespace`,
				);
			}
			if (!policy.account || typeof policy.account !== "object") {
				throw new AIError.ConfigurationError(`${path}.account must be an object`);
			}
			const baseIdentities = [policy.account.email, policy.account.accountId, policy.account.projectId];
			if (!baseIdentities.some(value => typeof value === "string" && value.length > 0)) {
				throw new AIError.ConfigurationError(
					`${path}.account must include at least one of email, accountId, or projectId`,
				);
			}
			for (const field of ["email", "accountId", "projectId", "orgId"] as const) {
				const value = policy.account[field];
				if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
					throw new AIError.ConfigurationError(`${path}.account.${field} must be a non-empty string`);
				}
			}
			if (policy.priority !== undefined && !Number.isFinite(policy.priority)) {
				throw new AIError.ConfigurationError(`${path}.priority must be a finite number`);
			}
			if (
				policy.reservePct !== undefined &&
				(!Number.isFinite(policy.reservePct) || policy.reservePct < 0 || policy.reservePct > 100)
			) {
				throw new AIError.ConfigurationError(`${path}.reservePct must be a finite number between 0 and 100`);
			}
		}
	}

	validateUsageCapability(provider: string, canFetchUsage: boolean): void {
		const policyIndex = this.#accountPolicies.findIndex(
			policy => policy.provider === provider && policy.reservePct !== undefined,
		);
		if (policyIndex !== -1 && !canFetchUsage) {
			throw new AIError.ConfigurationError(
				`auth.accountPolicies[${policyIndex}].reservePct requires a usage provider for ${provider}`,
			);
		}
	}

	validateFor(provider: string, credentials: readonly AuthCredential[]): void {
		const policies = this.#accountPolicies
			.map((policy, index) => ({ policy, index }))
			.filter(({ policy }) => policy.provider === provider);
		if (policies.length === 0) return;
		const oauthCredentials = credentials.filter(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
		if (oauthCredentials.length === 0) return;

		const claimedCredentials = new Map<number, number>();
		for (const { policy, index } of policies) {
			const matches: number[] = [];
			for (let credentialIndex = 0; credentialIndex < oauthCredentials.length; credentialIndex += 1) {
				if (matchesAuthAccountSelector(policy.account, oauthCredentials[credentialIndex]!)) {
					matches.push(credentialIndex);
				}
			}
			const path = `auth.accountPolicies[${index}].account`;
			if (matches.length === 0) {
				throw new AIError.ConfigurationError(`${path} matches no stored OAuth account for ${provider}`);
			}
			if (matches.length > 1) {
				throw new AIError.ConfigurationError(
					`${path} matches ${matches.length} stored OAuth accounts for ${provider}; add another identity field`,
				);
			}
			const credentialIndex = matches[0]!;
			const previousPolicyIndex = claimedCredentials.get(credentialIndex);
			if (previousPolicyIndex !== undefined) {
				throw new AIError.ConfigurationError(
					`auth.accountPolicies[${previousPolicyIndex}] and auth.accountPolicies[${index}] match the same stored OAuth account for ${provider}`,
				);
			}
			claimedCredentials.set(credentialIndex, index);
		}
	}

	/**
	 * Return the configured account policy matching an OAuth identity.
	 *
	 * This is a read-only diagnostics surface: it performs the same conjunctive
	 * selector match as routing and never refreshes, ranks, or mutates credentials.
	 */
	find(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined {
		return this.#accountPolicies.find(
			policy => policy.provider === provider && matchesAuthAccountSelector(policy.account, identity),
		);
	}

	/** Return the configured policy for a stored OAuth credential. */
	forCredential(provider: string, credential: AuthCredential): AuthAccountPolicy | undefined {
		return credential.type === "oauth" ? this.find(provider, credential) : undefined;
	}
}
