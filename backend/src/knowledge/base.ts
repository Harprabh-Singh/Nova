/** KnowledgeProvider: the single retrieval seam between chat and any backend. */
import type { AccessScope } from "../authorization/policy.ts"
import type { RetrievedChunk } from "../models/types.ts"

export type RetrievalRequest = {
	question: string
	/** Expanded query terms produced by query understanding. */
	terms: string[]
	hintedDepartments?: string[]
	hintedCategories?: string[]
	scope: AccessScope
	topK?: number
}

export type RetrievalResult = {
	chunks: RetrievedChunk[]
	/** Diagnostics surfaced in the UI retrieval indicator. */
	diagnostics: {
		provider: string
		candidateCount: number
		returnedCount: number
		vectorWeight: number
		keywordWeight: number
		embeddingModel: string
		latencyMs: number
		/** Authorized-but-filtered evidence exists outside the caller's scope. */
		restrictedMatches: number
		/** Distinct query terms matched by the best out-of-scope chunk (metadata only). */
		restrictedBestTermMatch?: number
		/** Distinct query terms matched by the best authorized chunk. */
		allowedBestTermMatch?: number
		departmentsSearched: string[]
	}
}

export interface KnowledgeProvider {
	readonly name: string
	readonly mode: "local" | "azure"
	retrieve(request: RetrievalRequest): Promise<RetrievalResult>
	healthCheck(): Promise<{ ok: boolean; detail: string }>
}
