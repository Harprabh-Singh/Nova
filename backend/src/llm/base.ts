/** LLM abstraction. Nothing in the app calls a model directly. */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

export type CompletionRequest = {
	messages: ChatMessage[]
	temperature?: number
	maxTokens?: number
	/**
	 * Retrieved, already-authorized evidence. Providers must treat this strictly
	 * as untrusted DATA and never as instructions.
	 */
	evidence?: EvidenceItem[]
}

export type EvidenceItem = {
	ref: string
	documentTitle: string
	department: string
	version: string
	section: string
	text: string
}

export type CompletionResult = {
	text: string
	provider: string
	model: string
	/** True when the answer came from the deterministic dev fallback, not a real model. */
	isFallback: boolean
	fallbackReason?: string
	usage?: { promptTokens?: number; completionTokens?: number }
	latencyMs: number
}

export interface LLMProvider {
	readonly name: string
	readonly mode: "local" | "azure"
	readonly model: string
	complete(request: CompletionRequest): Promise<CompletionResult>
	healthCheck(): Promise<{ ok: boolean; detail: string; model?: string }>
}

export class LLMError extends Error {
	constructor(
		message: string,
		/** Status NOVA will surface publicly (deliberately mapped, see azure/foundry.ts). */
		readonly statusCode = 502,
		/** Preserved diagnostic classification from the provider, if any. */
		readonly category?: string,
		/** Status the upstream provider actually returned, if any. */
		readonly upstreamStatus?: number,
		/** Provider correlation id, safe to log. */
		readonly requestId?: string,
	) {
		super(message)
		this.name = "LLMError"
	}
}
