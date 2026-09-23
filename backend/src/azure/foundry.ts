/**
 * Shared plumbing for the Microsoft Foundry OpenAI-compatible surface.
 *
 * One Foundry project endpoint serves both deployments:
 *
 *   https://<resource>.services.ai.azure.com/api/projects/<project>
 *      + /openai/v1/chat/completions   -> chat deployment   (nova-chat)
 *      + /openai/v1/embeddings         -> embedding deployment (nova-embedding)
 *
 * The deployment name travels in the request body's `model` field; there is no
 * `api-version` query parameter on the v1 route.
 *
 * This module exists so the chat and embedding providers share URL building,
 * authentication and error classification. It is NOT a provider and nothing
 * outside backend/src/llm and backend/src/embeddings should import it.
 *
 * Secrets: the key is held in memory only, attached to a request header, and
 * never returned, logged, or embedded in an error message.
 */

export type FoundryCredentials = {
	/** AZURE_API_KEY. Server-side only. */
	apiKey?: string
	/** Pre-acquired Microsoft Entra access token; preferred in production. */
	bearerToken?: string
}

export type FoundryErrorCategory =
	| "auth"
	| "not_found"
	| "rate_limited"
	| "bad_request"
	| "timeout"
	| "upstream"
	| "network"
	| "malformed"

/**
 * A Foundry failure with its diagnostic classification intact.
 *
 * `statusCode` is the UPSTREAM status exactly as Foundry returned it (or a
 * synthetic 504/503 for timeout/network). It is deliberately NOT the status
 * NOVA returns to its own clients - that public mapping lives in
 * `publicStatusFor()` and is documented in docs/azure-integration.md.
 */
export class FoundryError extends Error {
	constructor(
		message: string,
		readonly statusCode = 502,
		readonly category: FoundryErrorCategory = "upstream",
		/** Azure correlation id when the response carried one. Safe to log. */
		readonly requestId?: string,
	) {
		super(message)
		this.name = "FoundryError"
	}

	/** Compact, credential-free diagnostic string for logs. */
	get diagnostic(): string {
		return `[${this.category}/${this.statusCode}${this.requestId ? ` req=${this.requestId}` : ""}] ${this.message}`
	}
}

/**
 * Deliberate upstream -> public status mapping.
 *
 * A Foundry 401/403/404 is a NOVA server misconfiguration, not a problem with
 * the caller's request, so returning those statuses verbatim to a browser
 * would be actively misleading (a 401 would read as "your session expired").
 * They become 502. Statuses whose semantics do transfer are preserved:
 *
 *   401 / 403 / 404 -> 502  (server-side misconfiguration; category retained)
 *   408 / 504       -> 504  (timeout, caller may retry)
 *   429             -> 429  (rate limit, caller should back off)
 *   400             -> 502  (NOVA built the request, not the caller)
 *   5xx             -> 502  (provider failure)
 */
export function publicStatusFor(error: { category: FoundryErrorCategory; statusCode: number }): number {
	switch (error.category) {
		case "rate_limited":
			return 429
		case "timeout":
			return 504
		default:
			return 502
	}
}

/**
 * Build the OpenAI-compatible base URL from a Foundry project endpoint.
 * Tolerates a trailing slash and an endpoint that already ends in /openai/v1.
 */
export function foundryBaseUrl(projectEndpoint: string): string {
	const trimmed = projectEndpoint.trim().replace(/\/+$/, "")
	if (!trimmed) throw new FoundryError("Foundry project endpoint is not configured", 500, "bad_request")
	if (/\/openai\/v1$/.test(trimmed)) return trimmed
	return `${trimmed}/openai/v1`
}

export function foundryHeaders(credentials: FoundryCredentials): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" }
	// Entra wins when both are present: a real token is always preferable to a
	// long-lived key.
	if (credentials.bearerToken) headers["authorization"] = `Bearer ${credentials.bearerToken}`
	else if (credentials.apiKey) headers["api-key"] = credentials.apiKey
	return headers
}

export function hasFoundryCredentials(credentials: FoundryCredentials): boolean {
	return Boolean(credentials.bearerToken || credentials.apiKey)
}

/** Map an HTTP status onto a safe, user-presentable category and message. */
function classify(status: number): { category: FoundryError["category"]; message: string } {
	if (status === 400) return { category: "bad_request", message: "Foundry rejected the request as malformed" }
	if (status === 401) return { category: "auth", message: "Foundry rejected the credential (401)" }
	if (status === 403) return { category: "auth", message: "Foundry denied access to this deployment (403)" }
	if (status === 404)
		return { category: "not_found", message: "Foundry deployment or project endpoint not found (404)" }
	if (status === 408) return { category: "timeout", message: "Foundry request timed out (408)" }
	if (status === 429) return { category: "rate_limited", message: "Foundry rate limit reached (429)" }
	if (status >= 500) return { category: "upstream", message: `Foundry upstream error (${status})` }
	return { category: "upstream", message: `Foundry returned HTTP ${status}` }
}

export type FoundryRequest = {
	baseUrl: string
	path: "/chat/completions" | "/embeddings"
	body: unknown
	credentials: FoundryCredentials
	timeoutMs?: number
}

export type FoundryResponseMeta = {
	status: number
	latencyMs: number
	/** Azure request correlation id, safe to log. */
	requestId?: string
}

/**
 * POST to a Foundry v1 route and return parsed JSON.
 *
 * Failures become FoundryError with a category and a message that contains no
 * credential material and no raw provider payload.
 */
export async function foundryFetch<T>(request: FoundryRequest): Promise<{ data: T; meta: FoundryResponseMeta }> {
	const started = Date.now()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000)
	try {
		let response: Response
		try {
			response = await fetch(`${request.baseUrl}${request.path}`, {
				method: "POST",
				signal: controller.signal,
				headers: foundryHeaders(request.credentials),
				body: JSON.stringify(request.body),
			})
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				throw new FoundryError("Foundry request timed out", 504, "timeout")
			}
			throw new FoundryError("Foundry endpoint unreachable", 503, "network")
		}

		const meta: FoundryResponseMeta = {
			status: response.status,
			latencyMs: Date.now() - started,
			requestId: response.headers.get("apim-request-id") ?? response.headers.get("x-request-id") ?? undefined,
		}

		if (!response.ok) {
			// The body is deliberately discarded: provider error payloads can echo
			// request content, and this message reaches application logs.
			// The UPSTREAM status is preserved verbatim so 401/403/404/429 remain
			// distinguishable internally; the public status is decided later by
			// publicStatusFor().
			const { category, message } = classify(response.status)
			throw new FoundryError(message, response.status, category, meta.requestId)
		}

		let data: T
		try {
			data = (await response.json()) as T
		} catch {
			throw new FoundryError("Foundry returned a malformed response body", 502, "malformed", meta.requestId)
		}
		if (!data || typeof data !== "object") {
			throw new FoundryError("Foundry returned an empty response", 502, "malformed", meta.requestId)
		}
		return { data, meta }
	} finally {
		clearTimeout(timer)
	}
}
