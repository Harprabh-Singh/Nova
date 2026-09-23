/**
 * Low-level Azure AI Search REST client.
 *
 * Data plane (stable API version, no preview features):
 *   GET    {endpoint}/indexes/{index}?api-version=...            index definition
 *   PUT    {endpoint}/indexes/{index}?api-version=...            create/update index
 *   POST   {endpoint}/indexes/{index}/docs/index?api-version=... upload/merge/delete
 *   POST   {endpoint}/indexes/{index}/docs/search?api-version=... query
 *   GET    {endpoint}/indexes/{index}/docs/$count?api-version=... document count
 *
 * Security notes:
 * - The admin key is only ever sent in the `api-key` request header. It is never
 *   logged, never placed in a URL, and never included in an error message.
 * - Azure error payloads are truncated and scrubbed before they reach a
 *   SearchError, so an upstream response can never carry a credential outward.
 */

export type SearchErrorCategory = "auth" | "bad_request" | "not_found" | "conflict" | "rate_limit" | "upstream" | "network" | "timeout"

/** Mirrors FoundryError/EmbeddingError: structured, credential-free, never flattened. */
export class SearchError extends Error {
	constructor(
		message: string,
		readonly statusCode = 502,
		readonly category: SearchErrorCategory = "upstream",
		readonly upstreamStatus?: number,
		/** Azure correlation id when the response carried one. Safe to log. */
		readonly requestId?: string,
	) {
		super(message)
		this.name = "SearchError"
	}

	get diagnostic(): string {
		return `[${this.category}/${this.statusCode}${this.upstreamStatus ? ` upstream=${this.upstreamStatus}` : ""}${this.requestId ? ` req=${this.requestId}` : ""}] ${this.message}`
	}
}

/**
 * Upstream -> public status mapping, deliberately the same philosophy as
 * publicStatusFor() in azure/foundry.ts: a Search 401/403/404 is a NOVA
 * misconfiguration, not a problem with the browser's request, so it must not
 * be echoed verbatim to a caller.
 */
export function publicStatusForSearch(error: { category: SearchErrorCategory }): number {
	switch (error.category) {
		case "rate_limit":
			return 429
		case "timeout":
			return 504
		default:
			return 502
	}
}

function categoryForStatus(status: number): SearchErrorCategory {
	if (status === 401 || status === 403) return "auth"
	if (status === 404) return "not_found"
	if (status === 409) return "conflict"
	if (status === 429) return "rate_limit"
	if (status >= 400 && status < 500) return "bad_request"
	return "upstream"
}

/** Only transient classes are worth retrying; a bad filter will fail identically forever. */
function isRetryable(category: SearchErrorCategory): boolean {
	return category === "rate_limit" || category === "upstream" || category === "network" || category === "timeout"
}

export type SearchClientOptions = {
	endpoint: string
	index: string
	apiKey: string
	/** Stable data-plane version. Preview versions are deliberately not used. */
	apiVersion?: string
	timeoutMs?: number
	maxRetries?: number
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch
	/** Injectable for tests so backoff does not actually sleep. */
	sleepImpl?: (ms: number) => Promise<void>
}

export const DEFAULT_SEARCH_API_VERSION = "2024-07-01"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Removes anything credential-shaped from upstream text before it is attached
 * to an error. Defence in depth: Azure does not echo the api-key, but an error
 * message is the last place a secret should be able to reach.
 */
function scrub(text: string, secrets: string[]): string {
	let out = text.slice(0, 400)
	for (const secret of secrets) {
		if (secret && secret.length >= 8) out = out.split(secret).join("***")
	}
	return out.replace(/("?api[-_]?key"?\s*[:=]\s*)("[^"]*"|\S+)/gi, "$1***")
}

export class SearchClient {
	readonly endpoint: string
	readonly index: string
	readonly apiVersion: string
	private readonly timeoutMs: number
	private readonly maxRetries: number
	private readonly doFetch: typeof fetch
	private readonly doSleep: (ms: number) => Promise<void>

	constructor(private readonly options: SearchClientOptions) {
		if (!options.endpoint) throw new SearchError("AZURE_SEARCH_ENDPOINT is required", 500, "bad_request")
		if (!options.index) throw new SearchError("AZURE_SEARCH_INDEX is required", 500, "bad_request")
		if (!options.apiKey) throw new SearchError("AZURE_SEARCH_ADMIN_KEY is required", 500, "auth")
		this.endpoint = options.endpoint.replace(/\/+$/, "")
		this.index = options.index
		this.apiVersion = options.apiVersion || DEFAULT_SEARCH_API_VERSION
		this.timeoutMs = options.timeoutMs ?? 30_000
		this.maxRetries = options.maxRetries ?? 3
		this.doFetch = options.fetchImpl ?? fetch
		this.doSleep = options.sleepImpl ?? sleep
	}

	/** Endpoint + index only. Contains no credential, so it is safe to log. */
	get descriptor(): string {
		return `${this.endpoint}/indexes/${this.index}`
	}

	private url(path: string, params: Record<string, string> = {}): string {
		const query = new URLSearchParams({ "api-version": this.apiVersion, ...params })
		return `${this.endpoint}${path}?${query.toString()}`
	}

	private async request<T>(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
		let lastError: SearchError | null = null
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), this.timeoutMs)
			try {
				const response = await this.doFetch(this.url(path, params), {
					method,
					headers: {
						"api-key": this.options.apiKey,
						...(body === undefined ? {} : { "content-type": "application/json" }),
						accept: "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: controller.signal,
				})
				const requestId = response.headers?.get?.("request-id") ?? undefined
				if (response.ok) {
					if (response.status === 204) return undefined as T
					const text = await response.text()
					return (text ? JSON.parse(text) : undefined) as T
				}
				const category = categoryForStatus(response.status)
				const detail = scrub(await response.text().catch(() => ""), [this.options.apiKey])
				lastError = new SearchError(
					`Azure AI Search ${method} ${path} failed: HTTP ${response.status}${detail ? ` - ${detail}` : ""}`,
					publicStatusForSearch({ category }),
					category,
					response.status,
					requestId,
				)
				if (!isRetryable(category) || attempt === this.maxRetries) throw lastError
				// Honour Retry-After when Azure supplies it, otherwise bounded exponential backoff.
				const retryAfter = Number(response.headers?.get?.("retry-after") ?? "")
				await this.doSleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500)
				continue
			} catch (error) {
				clearTimeout(timer)
				if (error instanceof SearchError) throw error
				const aborted = (error as Error)?.name === "AbortError"
				const category: SearchErrorCategory = aborted ? "timeout" : "network"
				lastError = new SearchError(
					aborted
						? `Azure AI Search request timed out after ${this.timeoutMs}ms`
						: `Azure AI Search is unreachable: ${scrub(String((error as Error)?.message ?? "unknown"), [this.options.apiKey])}`,
					publicStatusForSearch({ category }),
					category,
				)
				if (attempt === this.maxRetries) throw lastError
				await this.doSleep(2 ** attempt * 500)
				continue
			} finally {
				clearTimeout(timer)
			}
		}
		throw lastError ?? new SearchError("Azure AI Search request failed", 502, "upstream")
	}

	/** Returns the live index definition, or null when the index does not exist. */
	async getIndex(): Promise<any | null> {
		try {
			return await this.request<any>("GET", `/indexes/${encodeURIComponent(this.index)}`)
		} catch (error) {
			if (error instanceof SearchError && error.category === "not_found") return null
			throw error
		}
	}

	async createOrUpdateIndex(definition: unknown): Promise<any> {
		return this.request<any>("PUT", `/indexes/${encodeURIComponent(this.index)}`, definition)
	}

	/** Explicit administrative operation only; never called automatically. */
	async deleteIndex(): Promise<void> {
		await this.request<void>("DELETE", `/indexes/${encodeURIComponent(this.index)}`)
	}

	async indexDocuments(actions: Array<Record<string, unknown>>): Promise<Array<{ key: string; status: boolean; errorMessage?: string }>> {
		if (actions.length === 0) return []
		const result = await this.request<any>("POST", `/indexes/${encodeURIComponent(this.index)}/docs/index`, { value: actions })
		return (result?.value ?? []).map((r: any) => ({ key: String(r.key), status: Boolean(r.status), errorMessage: r.errorMessage }))
	}

	async search(body: Record<string, unknown>): Promise<any> {
		return this.request<any>("POST", `/indexes/${encodeURIComponent(this.index)}/docs/search`, body)
	}

	async documentCount(): Promise<number> {
		const raw = await this.request<any>("GET", `/indexes/${encodeURIComponent(this.index)}/docs/$count`)
		return Number(raw ?? 0)
	}
}
