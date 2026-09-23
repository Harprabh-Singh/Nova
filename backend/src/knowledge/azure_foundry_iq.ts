/**
 * AzureKnowledgeProvider - production/Azure retrieval (KNOWLEDGE_MODE=azure).
 *
 * Same KnowledgeProvider contract as the local implementation, so the chat
 * service is unchanged when this is switched on. The pipeline is:
 *
 *   server-resolved AccessScope
 *     -> query embedding (nova-embedding, one call per real user query)
 *     -> Azure AI Search hybrid query with ONE authoritative security filter
 *     -> authorized chunks only
 *     -> re-rank -> citations -> nova-chat
 *
 * The authorization scope is handed to the store intact and compiled into an
 * OData filter there. An earlier revision of this file flattened the scope into
 * `departments` + a single `maxClassificationLevel`, which (a) dropped the role
 * and user ACLs entirely and (b) applied the caller's highest clearance in ANY
 * department to EVERY department. Both were privilege-escalation bugs; the
 * scope must never be flattened again.
 */
import type { KnowledgeProvider, RetrievalRequest, RetrievalResult } from "./base.ts"
import type { VectorStore } from "../retrieval/vector/base.ts"
import type { EmbeddingProvider } from "../embeddings/base.ts"
import type { RetrievedChunk } from "../models/types.ts"
import { rerank } from "../retrieval/rerank.ts"
import { getConfig } from "../config/index.ts"
import { tokenize } from "../embeddings/local.ts"

export class AzureKnowledgeProvider implements KnowledgeProvider {
	readonly name = "AzureKnowledgeProvider"
	readonly mode = "azure" as const

	constructor(
		private readonly vectorStore: VectorStore,
		private readonly embeddings: EmbeddingProvider,
	) {}

	async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
		const started = Date.now()
		const config = getConfig()
		const topK = request.topK ?? config.retrieval.topK

		// 1. The scope is resolved server-side and passed through untouched.
		//    Nothing here comes from the request body.
		const filter = {
			tenantId: request.scope.tenantId,
			scope: request.scope,
			onlyActiveVersions: true,
			departments: request.hintedDepartments?.length ? request.hintedDepartments : undefined,
		}

		// 2. Exactly one embedding call per real user query. If it fails, the
		//    EmbeddingError propagates: no fake vector, no local fallback.
		const queryVector = await this.embeddings.embedOne([request.question, ...request.terms].join(" "))

		// 3. Hybrid (lexical + vector) retrieval with security trimming applied
		//    by Azure AI Search before anything is returned.
		const raw = await this.vectorStore.search(
			queryVector,
			[request.question, ...request.terms],
			filter,
			config.retrieval.candidates,
		)

		const candidates: RetrievedChunk[] = raw.map((r) => ({
			chunkId: r.chunkId,
			tenantId: r.tenantId,
			documentId: r.documentId,
			versionId: r.versionId,
			documentTitle: r.documentTitle,
			department: r.department,
			category: r.category,
			classification: r.classification,
			version: r.version,
			section: r.section,
			seq: r.seq,
			text: r.text,
			vectorScore: r.vectorScore,
			keywordScore: r.keywordScore,
			score: 0,
			injectionFlags: r.injectionFlags,
		}))

		const chunks = rerank(
			candidates,
			{
				vectorWeight: config.retrieval.vectorWeight,
				keywordWeight: config.retrieval.keywordWeight,
				userDepartment: request.scope.department,
				hintedDepartments: request.hintedDepartments,
				hintedCategories: request.hintedCategories,
			},
			topK,
		)

		// 4. Metadata-only probe so the agent can say "you may not see this"
		//    instead of "we do not know". Counts only; no restricted content.
		const restrictedMatches =
			(await this.vectorStore.countMatchingOutsideScope?.([request.question, ...request.terms], filter)) ?? 0
		const probeTerms = [...new Set(tokenize([request.question, ...request.terms].join(" ")))]
		const allowedBestTermMatch = chunks.slice(0, 3).reduce((best, chunk) => {
			const haystack = `${chunk.documentTitle} ${chunk.section} ${chunk.text}`.toLowerCase()
			return Math.max(best, probeTerms.filter((term) => haystack.includes(term)).length)
		}, 0)

		return {
			chunks,
			diagnostics: {
				provider: this.name,
				candidateCount: candidates.length,
				returnedCount: chunks.length,
				vectorWeight: config.retrieval.vectorWeight,
				keywordWeight: config.retrieval.keywordWeight,
				embeddingModel: this.embeddings.model,
				latencyMs: Date.now() - started,
				restrictedMatches,
				allowedBestTermMatch,
				departmentsSearched: [...new Set(candidates.map((c) => c.department))],
			},
		}
	}

	/** Local configuration inspection only; performs no Search or model call. */
	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		return this.vectorStore.healthCheck()
	}
}
// hist: 2026-09-23T10:16:57+05:30
