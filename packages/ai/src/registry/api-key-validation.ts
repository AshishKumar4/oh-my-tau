import { type } from "@oh-my-pi/omptype";
import { OpenAIHttpError, ProviderHttpError } from "../error/classes";
import { isAnthropicWorkspaceDenial } from "../error/flags";
import type { FetchImpl } from "../types";

type OpenAICompatibleValidationOptions = {
	provider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	maxTokens?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	tolerateModelDenied?: boolean;
};
type AnthropicCompatibleValidationOptions = {
	provider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
};

type ModelListValidationOptions = {
	provider: string;
	apiKey: string;
	modelsUrl: string;
	headers?: Record<string, string> | (() => Record<string, string> | undefined);
	signal?: AbortSignal;
	fetch?: FetchImpl;
};

type ErrorEnvelope = {
	details: string;
	code: string | undefined;
};

const VALIDATION_TIMEOUT_MS = 15_000;

function normalizeAnthropicCompatibleBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function resolveValidationHeaders(
	headers: Record<string, string> | (() => Record<string, string> | undefined) | undefined,
): Record<string, string> | undefined {
	return typeof headers === "function" ? headers() : headers;
}

async function readErrorEnvelope(response: Response): Promise<ErrorEnvelope> {
	let details = "";
	try {
		details = (await response.text()).trim();
	} catch {
		// Ignore body read errors; the HTTP status still preserves the failure category.
	}

	let bodyJson: unknown;
	try {
		bodyJson = details ? JSON.parse(details) : undefined;
	} catch {
		bodyJson = undefined;
	}
	const { code } = OpenAIHttpError.parseEnvelope(bodyJson, details);
	return { details, code };
}

async function createApiKeyValidationError(
	provider: string,
	response: Response,
	envelope?: ErrorEnvelope,
): Promise<ProviderHttpError> {
	const { details, code } = envelope ?? (await readErrorEnvelope(response));

	const message = details
		? `${provider} API key validation failed (${response.status}): ${details}`
		: `${provider} API key validation failed (${response.status})`;
	return new ProviderHttpError(message, response.status, { headers: response.headers, code });
}

/**
 * Validate an API key against an OpenAI-compatible chat completions endpoint.
 *
 * Performs a minimal request to verify credentials and endpoint access.
 */
export async function validateOpenAICompatibleApiKey(options: OpenAICompatibleValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? fetch;

	const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${options.apiKey}`,
		},
		body: JSON.stringify({
			model: options.model,
			messages: [{ role: "user", content: "ping" }],
			[options.maxTokensField ?? "max_tokens"]: options.maxTokens ?? 1,
			temperature: 0,
		}),
		signal,
	});

	if (response.ok) {
		return;
	}

	const envelope = await readErrorEnvelope(response);
	if (options.tolerateModelDenied && response.status === 401 && envelope.code === "invalid_model") {
		return;
	}

	throw await createApiKeyValidationError(options.provider, response, envelope);
}

/**
 * Validate an API key against an Anthropic-compatible messages endpoint.
 */
export async function validateAnthropicCompatibleApiKey(options: AnthropicCompatibleValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const baseUrl = normalizeAnthropicCompatibleBaseUrl(options.baseUrl);
	const fetchImpl = options.fetch ?? fetch;

	const response = await fetchImpl(`${baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": options.apiKey,
		},
		body: JSON.stringify({
			model: options.model,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
		}),
		signal,
	});

	if (response.ok) {
		return;
	}

	throw await createApiKeyValidationError(options.provider, response);
}

/**
 * Validate an API key against a provider models endpoint.
 *
 * Useful for providers where access to specific models may vary by plan and
 * should not block key validation.
 */
export async function validateApiKeyAgainstModelsEndpoint(options: ModelListValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? fetch;

	const response = await fetchImpl(options.modelsUrl, {
		method: "GET",
		headers: {
			...resolveValidationHeaders(options.headers),
			Authorization: `Bearer ${options.apiKey}`,
		},
		signal,
	});

	if (response.ok) {
		return;
	}

	throw await createApiKeyValidationError(options.provider, response);
}

/** Where the Claude Console lists an organization's workspaces and their IDs. */
export const ANTHROPIC_WORKSPACES_URL = "https://platform.claude.com/settings/workspaces";

/** A workspace an Anthropic API key can name in `anthropic-workspace-id`. */
export interface AnthropicWorkspace {
	id: string;
	name: string;
}

/**
 * Asks the user to settle an Anthropic key's workspace. Either callback
 * resolves `undefined` when the user cancels.
 */
export interface AnthropicWorkspacePrompts {
	/** Choose among the workspaces the key lists. */
	pick(workspaces: readonly AnthropicWorkspace[]): Promise<string | undefined>;
	/** Enter a workspace ID; the key may not list workspaces. */
	ask(): Promise<string | undefined>;
}

const workspaceListSchema = type({
	data: type({ id: "string", name: "string", "archived_at?": "string | null" }).array(),
});

async function requestAnthropicModels(
	baseUrl: string,
	apiKey: string,
	workspaceId: string | undefined,
	signal: AbortSignal,
	fetchImpl: FetchImpl,
): Promise<Response> {
	return fetchImpl(`${baseUrl}/v1/models?limit=1`, {
		method: "GET",
		headers: {
			"anthropic-version": "2023-06-01",
			"x-api-key": apiKey,
			...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}),
		},
		signal,
	});
}

/** The key's unarchived workspaces, or `undefined` when it may not list them (that needs an admin's key). */
async function listAnthropicWorkspaces(
	baseUrl: string,
	apiKey: string,
	signal: AbortSignal,
	fetchImpl: FetchImpl,
): Promise<AnthropicWorkspace[] | undefined> {
	const response = await fetchImpl(`${baseUrl}/v1/organizations/workspaces?include_default=true&limit=1000`, {
		method: "GET",
		headers: { "anthropic-version": "2023-06-01", "x-api-key": apiKey },
		signal,
	});
	if (!response.ok) return undefined;
	// A body that is not a workspace list (a proxy page, say) means the same as a refusal: ask.
	const parsed = workspaceListSchema(await response.json().catch(() => undefined));
	if (parsed instanceof type.errors) return undefined;
	return parsed.data.flatMap(({ id, name, archived_at }) => (archived_at ? [] : [{ id, name }]));
}

/**
 * Settle the workspace an Anthropic API key needs before it is stored. An
 * explicit `workspaceId` is used as given. Otherwise a key scoped to a
 * workspace needs none, and a key that is not must name one on every request:
 * its only workspace is used, the user picks among several, and the user
 * enters an ID when the key may not list them. A named workspace is verified
 * against the API. Resolves `undefined` when the user cancels; throws for a key
 * or workspace the API rejects.
 */
export async function resolveAnthropicKeyWorkspace(
	apiKey: string,
	prompts: AnthropicWorkspacePrompts,
	options: { baseUrl: string; workspaceId?: string; signal?: AbortSignal; fetch?: FetchImpl },
): Promise<{ workspaceId?: string } | undefined> {
	const fetchImpl = options.fetch ?? fetch;
	const baseUrl = normalizeAnthropicCompatibleBaseUrl(options.baseUrl);
	// One timeout per request: the prompts may wait on the user far longer.
	const requestSignal = () =>
		options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(VALIDATION_TIMEOUT_MS)])
			: AbortSignal.timeout(VALIDATION_TIMEOUT_MS);

	let workspaceId = options.workspaceId?.trim();
	if (!workspaceId) {
		const probe = await requestAnthropicModels(baseUrl, apiKey, undefined, requestSignal(), fetchImpl);
		if (probe.ok) return {};
		const error = await createApiKeyValidationError("Anthropic", probe);
		if (probe.status !== 400 || !isAnthropicWorkspaceDenial(error)) throw error;

		const workspaces = await listAnthropicWorkspaces(baseUrl, apiKey, requestSignal(), fetchImpl);
		workspaceId = (
			!workspaces?.length
				? await prompts.ask()
				: workspaces.length === 1
					? workspaces[0].id
					: await prompts.pick(workspaces)
		)?.trim();
		if (!workspaceId) return undefined;
	}

	const verify = await requestAnthropicModels(baseUrl, apiKey, workspaceId, requestSignal(), fetchImpl);
	if (!verify.ok) throw await createApiKeyValidationError("Anthropic", verify);
	return { workspaceId };
}
