/**
 * AzureFoundryLLMProvider - active only when AI_MODE=azure.
 *
 * Microsoft Foundry, OpenAI-compatible v1 surface:
 *
 *   POST {FOUNDRY_ENDPOINT}/openai/v1/chat/completions
 *   Headers: api-key: <AZURE_API_KEY>   (or Authorization: Bearer <Entra token>)
 *   Body:    { "model": "<deployment name>", "messages": [...] }
 *
 * The deployment name goes in the body's `model` field. There is no
 * `api-version` query parameter on this route.
 *
 * The raw provider response never leaves this file: it is converted into
 * NOVA's CompletionResult before returning.
 */
import type { CompletionRequest, CompletionResult, LLMProvider } from "./base.ts"
import { LLMError } from "./base.ts"
import { FoundryError, foundryBaseUrl, foundryFetch, hasFoundryCredentials, publicStatusFor } from "../azure/foundry.ts"

export type AzureFoundryOptions = {
	/** Foundry project endpoint, e.g. https://<res>.services.ai.azure.com/api/projects/nova-foundry */
	endpoint: string
	/** Deployment name, e.g. nova-chat. Sent as `model`. */
	deployment: string
	apiKey?: string
	/** Optional pre-acquired Entra access token (preferred over api keys). */
	bearerToken?: string
	project?: string
	timeoutMs?: number
}

type ChatCompletionResponse = {
	choices?: Array<{ message?: { content?: string } }>
	usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class AzureFoundryLLMProvider implements LLMProvider {
	readonly name = "AzureFoundryLLMProvider"
	readonly mode = "azure" as const

	private readonly baseUrl: string

	constructor(private readonly options: AzureFoundryOptions) {
		if (!options.endpoint || !options.deployment) {
			throw new LLMError(
				"AI_MODE=azure requires FOUNDRY_ENDPOINT and FOUNDRY_MODEL_DEPLOYMENT. See docs/azure-integration.md",
				500,
			)
		}
		if (!hasFoundryCredentials(options)) {
			// Fail loudly at construction rather than silently degrading to local.
			throw new LLMError(
				"AI_MODE=azure requires AZURE_API_KEY (or an Entra access token). See docs/azure-integration.md",
				500,
			)
		}
		this.baseUrl = foundryBaseUrl(options.endpoint)
	}

	get model(): string {
		return this.options.deployment
	}

	/** Safe to log: contains no credential. */
	get endpointForLogs(): string {
		return `${this.baseUrl}/chat/completions`
	}

	async complete(request: CompletionRequest): Promise<CompletionResult> {
		const started = Date.now()
		try {
			const { data } = await foundryFetch<ChatCompletionResponse>({
				baseUrl: this.baseUrl,
				path: "/chat/completions",
				credentials: this.options,
				timeoutMs: this.options.timeoutMs ?? 60_000,
				body: {
					model: this.options.deployment,
					messages: request.messages,
					temperature: request.temperature ?? 0.1,
					max_tokens: request.maxTokens ?? 800,
				},
			})
			const text = data.choices?.[0]?.message?.content?.trim()
			if (!text) throw new LLMError("Azure Foundry returned an empty completion")
			return {
				text,
				provider: "azure-foundry",
				model: this.options.deployment,
				// Azure answers are never fallbacks: if Azure fails, the call fails.
				isFallback: false,
				usage: {
					promptTokens: data.usage?.prompt_tokens,
					completionTokens: data.usage?.completion_tokens,
				},
				latencyMs: Date.now() - started,
			}
		} catch (error) {
			if (error instanceof FoundryError) {
				// The upstream status and category survive; only the PUBLIC status is
				// remapped (see publicStatusFor). Nothing credential-bearing is copied.
				throw new LLMError(
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

	/**
	 * MANUAL DIAGNOSTIC ONLY - this performs a real (billable) chat call.
	 * `/api/health` and `/api/admin/metrics` never invoke it; they inspect
	 * local configuration and provider identity instead. Use it from scripts
	 * such as `npm run test:foundry` or from an operator console.
	 */
	async healthCheck(): Promise<{ ok: boolean; detail: string; model?: string }> {
		try {
			await foundryFetch<ChatCompletionResponse>({
				baseUrl: this.baseUrl,
				path: "/chat/completions",
				credentials: this.options,
				timeoutMs: 15_000,
				body: {
					model: this.options.deployment,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				},
			})
			return {
				ok: true,
				detail: `Foundry deployment ${this.options.deployment} responded`,
				model: this.options.deployment,
			}
		} catch (error) {
			return {
				ok: false,
				detail: error instanceof FoundryError ? error.diagnostic : "Foundry unreachable",
				model: this.options.deployment,
			}
		}
	}
}
// hist: 2026-09-22T22:31:18+05:30
