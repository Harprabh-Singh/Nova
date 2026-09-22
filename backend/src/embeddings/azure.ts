/**
 * AzureEmbeddingProvider - active only when AI_MODE=azure.
 *
 * Microsoft Foundry, OpenAI-compatible v1 surface:
 *
 *   POST {FOUNDRY_ENDPOINT}/openai/v1/embeddings
 *   Body: { "model": "<deployment>", "input": [...], "dimensions": <EMBEDDING_DIM> }
 *
 * Dimensions: NOVA stores vectors at EMBEDDING_DIM (384 by default) and every
 * stored vector, the local provider and the retrieval math all assume that
 * width. text-embedding-3-small returns 1536 by default but supports the
 * `dimensions` parameter, so the deployment is asked for NOVA's configured
 * width rather than silently changing the application's vector dimension.
 * The response width is then verified, because a mismatch would corrupt the
 * index rather than fail visibly.
 */
import type { EmbeddingProvider } from "./base.ts"
import { EmbeddingError } from "./base.ts"
import { FoundryError, foundryBaseUrl, foundryFetch, hasFoundryCredentials, publicStatusFor } from "../azure/foundry.ts"

export type AzureEmbeddingOptions = {
	/** Foundry project endpoint (same one the chat provider uses). */
	endpoint: string
	/** Deployment name, e.g. nova-embedding. Sent as `model`. */
	deployment: string
	apiKey?: string
	bearerToken?: string
	dim: number
	timeoutMs?: number
}

type EmbeddingResponse = {
	data?: Array<{ embedding?: number[] }>
}

export class AzureEmbeddingProvider implements EmbeddingProvider {
	readonly name = "AzureEmbeddingProvider"
	readonly mode = "azure" as const

	private readonly baseUrl: string

	constructor(private readonly options: AzureEmbeddingOptions) {
		if (!options.endpoint || !options.deployment) {
			throw new EmbeddingError(
				"AI_MODE=azure requires FOUNDRY_ENDPOINT and AZURE_EMBEDDING_DEPLOYMENT",
				500,
				"bad_request",
			)
		}
		if (!hasFoundryCredentials(options)) {
			throw new EmbeddingError(
				"AI_MODE=azure requires AZURE_API_KEY (or an Entra access token)",
				500,
				"auth",
			)
		}
		this.baseUrl = foundryBaseUrl(options.endpoint)
	}

	get model(): string {
		return this.options.deployment
	}

	get dim(): number {
		return this.options.dim
	}

	/** Safe to log: contains no credential. */
	get endpointForLogs(): string {
		return `${this.baseUrl}/embeddings`
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return []
		try {
			const { data } = await foundryFetch<EmbeddingResponse>({
				baseUrl: this.baseUrl,
				path: "/embeddings",
				credentials: this.options,
				timeoutMs: this.options.timeoutMs ?? 60_000,
				body: {
					model: this.options.deployment,
					input: texts,
					dimensions: this.options.dim,
				},
			})
			const rows = data.data ?? []
			if (rows.length !== texts.length) {
				throw new FoundryError("Foundry returned a different number of embeddings than inputs", 502, "malformed")
			}
			return rows.map((row) => {
				const values = row.embedding
				if (!Array.isArray(values) || values.length === 0) {
					throw new FoundryError("Foundry returned an empty embedding vector", 502, "malformed")
				}
				if (values.length !== this.options.dim) {
					// Loud failure beats a corrupted vector index.
					throw new FoundryError(
						`Embedding dimension mismatch: deployment ${this.options.deployment} returned ${values.length}, NOVA expects EMBEDDING_DIM=${this.options.dim}`,
						500,
						"malformed",
					)
				}
				return Float32Array.from(values)
			})
		} catch (error) {
			if (error instanceof FoundryError) {
				// Preserve category, upstream status and correlation id instead of
				// flattening everything into a bare Error.
				throw new EmbeddingError(
					error.message,
					publicStatusFor(error),
					error.category,
					error.statusCode,
					error.requestId,
				)
			}
			throw error
		}
	}

	async embedOne(text: string): Promise<Float32Array> {
		return (await this.embed([text]))[0]
	}

	/**
	 * MANUAL DIAGNOSTIC ONLY - this performs a real (billable) embedding call.
	 * `/api/health` and `/api/admin/metrics` never invoke it; they inspect
	 * local configuration and provider identity instead.
	 */
	async healthCheck(): Promise<{ ok: boolean; detail: string; model?: string }> {
		try {
			const [vector] = await this.embed(["health"])
			return {
				ok: true,
				detail: `Azure embedding deployment ${this.options.deployment} responded (dim ${vector.length})`,
				model: this.model,
			}
		} catch (error) {
			const detail =
				error instanceof EmbeddingError
					? `[${error.category ?? "unknown"}/${error.upstreamStatus ?? error.statusCode}] ${error.message}`
					: (error as Error).message
			return { ok: false, detail: `Azure embeddings unavailable: ${detail}`, model: this.model }
		}
	}
}
// hist: 2026-09-22T23:44:42+05:30
