/**
 * The two - and only two - ways a governed action can actually happen.
 *
 *   LocalMockExecutor    runs the ActionDefinition's own `runLocally`. Nothing
 *                        leaves the process. Every result is stamped
 *                        simulated: true, and the UI shows SIMULATED ACTION.
 *                        Mock behaviour is never dressed up as an integration.
 *
 *   AzureFunctionExecutor calls the NOVA Actions Function app over HTTPS. Its
 *                        results are NOT simulated, so it is constructed only
 *                        when ACTION_MODE=azure, and construction FAILS when the
 *                        endpoint is missing. There is deliberately no
 *                        try-Azure-then-fall-back-to-mock path: a person told
 *                        "ticket ITR-2025-0001 raised" must be able to find it.
 *
 * Which one is loaded is decided by a human through ACTION_MODE, never inferred
 * from the presence of a URL.
 */
import { getConfig } from "../../config/index.ts"
import { log } from "../../observability/logger.ts"
import { GovernedActionError } from "./types.ts"
import type {
	ActionDefinition,
	ActionExecutionContext,
	ActionExecutionResult,
	ActionExecutor,
	ActionInput,
} from "./types.ts"

/* ------------------------------- local mock ------------------------------ */

export class LocalMockExecutor implements ActionExecutor {
	readonly name = "local_mock" as const
	readonly simulated = true

	async execute(
		definition: ActionDefinition,
		input: ActionInput,
		context: ActionExecutionContext,
	): Promise<ActionExecutionResult> {
		const result = definition.runLocally(input, context)
		return {
			...result,
			summary: `${result.summary} (SIMULATED - no external system of record was written.)`,
		}
	}
}

/* ---------------------------- azure function ----------------------------- */

export type AzureFunctionExecutorOptions = {
	/** Function app origin, e.g. https://nova-actions.azurewebsites.net */
	baseUrl: string
	/** Optional function key. Omitted when the app is fronted by APIM/Entra. */
	functionKey?: string
	timeoutMs?: number
	/** Injected in tests so no test ever needs the network. */
	fetchImpl?: typeof fetch
}

type FunctionResponseBody = {
	ok?: boolean
	reference?: string
	summary?: string
	detail?: Record<string, string | number | boolean>
	error?: { code?: string; message?: string; fields?: Record<string, string> }
}

export class AzureFunctionExecutor implements ActionExecutor {
	readonly name = "azure_function" as const
	readonly simulated = false
	private readonly baseUrl: string
	private readonly fetchImpl: typeof fetch

	constructor(private readonly options: AzureFunctionExecutorOptions) {
		if (!options.baseUrl) {
			// Mirrors the config guard, so constructing this class directly is
			// equally impossible to get wrong.
			throw new GovernedActionError(
				"function_unavailable",
				"ACTION_MODE=azure requires AZURE_ACTION_FUNCTION_URL. Governed actions are disabled.",
			)
		}
		this.baseUrl = options.baseUrl.replace(/\/+$/, "")
		this.fetchImpl = options.fetchImpl ?? fetch
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json" }
		// The key is a header value and nothing else: it is never put in the URL
		// (where it would land in every proxy and App Service access log).
		if (this.options.functionKey) headers["x-functions-key"] = this.options.functionKey
		return headers
	}

	async execute(
		definition: ActionDefinition,
		input: ActionInput,
		context: ActionExecutionContext,
	): Promise<ActionExecutionResult> {
		const url = `${this.baseUrl}/api/actions/${definition.functionRoute}`
		/**
		 * The tenant and actor sent downstream come from the SERVER-resolved
		 * context, not from the request body. The Function app is a second
		 * enforcement point, not the first: it re-validates the payload against
		 * the same schema, but it trusts NOVA for identity.
		 */
		const payload = {
			actionId: definition.id,
			actionRequestId: context.actionRequestId,
			tenantId: context.tenantId,
			requestId: context.requestId,
			actor: context.actor,
			source: context.source,
			input,
		}

		let response: Response
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
			})
		} catch (error) {
			// Transport failure: DNS, TLS, connection refused, timeout. The
			// endpoint and the underlying message are LOGGED, never returned.
			log.error("action.function.unreachable", {
				actionId: definition.id,
				actionRequestId: context.actionRequestId,
				detail: (error as Error).message,
			})
			throw new GovernedActionError(
				"function_unavailable",
				"The enterprise action service could not be reached, so nothing was submitted. Please retry.",
			)
		}

		const text = await response.text().catch(() => "")
		let body: FunctionResponseBody = {}
		if (text) {
			try {
				body = JSON.parse(text) as FunctionResponseBody
			} catch {
				body = {}
			}
		}

		if (!response.ok) {
			log.error("action.function.failed", {
				actionId: definition.id,
				actionRequestId: context.actionRequestId,
				upstreamStatus: response.status,
				upstreamCode: body.error?.code ?? null,
			})
			/**
			 * A 4xx from the Function app means it REFUSED the action on its
			 * merits (its own schema check, its own business rule). That is
			 * `action_failed` - retrying identically will not help. A 5xx means
			 * the service itself broke: `function_error`.
			 */
			if (response.status === 400 || response.status === 422) {
				throw new GovernedActionError(
					"action_failed",
					body.error?.message
						? `The enterprise action service rejected this request: ${String(body.error.message).slice(0, 200)}`
						: "The enterprise action service rejected this request. Nothing was submitted.",
					body.error?.fields ?? {},
				)
			}
			if (response.status === 401 || response.status === 403) {
				throw new GovernedActionError(
					"function_error",
					"NOVA is not authorised to call the enterprise action service. Nothing was submitted.",
				)
			}
			throw new GovernedActionError(
				"function_error",
				`The enterprise action service returned an error (HTTP ${response.status}). Nothing was confirmed as submitted.`,
			)
		}

		if (!body.ok || !body.reference) {
			log.error("action.function.malformed", {
				actionId: definition.id,
				actionRequestId: context.actionRequestId,
				upstreamStatus: response.status,
			})
			throw new GovernedActionError(
				"function_error",
				"The enterprise action service returned an unrecognised response, so the outcome is unknown. Check the downstream system before retrying.",
			)
		}

		return {
			reference: String(body.reference),
			summary: String(body.summary ?? `${definition.name} submitted as ${body.reference}.`),
			detail: body.detail ?? {},
		}
	}
}

/* -------------------------------- factory -------------------------------- */

/**
 * Build the executor the configuration asks for.
 * `fetchImpl` exists only so the Azure path is testable without a network.
 */
export function createActionExecutor(options: { fetchImpl?: typeof fetch } = {}): ActionExecutor {
	const config = getConfig()
	if (config.modes.actionMode !== "azure") return new LocalMockExecutor()
	return new AzureFunctionExecutor({
		baseUrl: config.azure?.action.functionUrl ?? "",
		functionKey: config.azure?.action.functionKey,
		timeoutMs: config.azure?.action.functionTimeoutMs,
		fetchImpl: options.fetchImpl,
	})
}
