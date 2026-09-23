/**
 * LocalKnowledgeProvider: hybrid (vector + BM25 keyword) retrieval over the
 * local vector store, with tenant + authorization + version filters pushed down
 * into the query and a metadata-aware re-ranking stage on top.
 */
import type { KnowledgeProvider, RetrievalRequest, RetrievalResult } from "./base.ts"
import type { VectorStore } from "../retrieval/vector/base.ts"
import type { EmbeddingProvider } from "../embeddings/base.ts"
import { rerank } from "../retrieval/rerank.ts"
import { accessSqlFilter } from "../authorization/policy.ts"
import type { RetrievedChunk } from "../models/types.ts"
import { getConfig } from "../config/index.ts"
import { tokenize } from "../embeddings/local.ts"

export class LocalKnowledgeProvider implements KnowledgeProvider {
	readonly name = "LocalKnowledgeProvider"
	readonly mode = "local" as const

	constructor(
		private readonly vectorStore: VectorStore,
		private readonly embeddings: EmbeddingProvider,
	) {}

	async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
		const started = Date.now()
		const config = getConfig()
		const topK = request.topK ?? config.retrieval.topK

		// 1. Authorization is resolved first and pushed into the store query.
		const accessSql = accessSqlFilter(request.scope)
		const filter = {
			tenantId: request.scope.tenantId,
			accessSql,
			onlyActiveVersions: true,
		}

		// 2. Semantic + keyword retrieval over the authorized candidate set only.
		const queryVector = await this.embeddings.embedOne(
			[request.question, ...request.terms, ...(request.hintedDepartments ?? [])].join(" "),
		)
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

		// 3. Re-rank with metadata signals, then cap per-document contribution.
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

		// 4. Metadata-only probe: does matching evidence exist beyond the caller's
		//    clearance? Returns a count only, so nothing confidential is revealed.
		const restrictedMatches =
			(await this.vectorStore.countMatchingOutsideScope?.([request.question, ...request.terms], filter)) ?? 0
		// How well does the *unauthorized* material match, compared with what the
		// caller is allowed to see? Counts only - no restricted content is returned.
		const probeTerms = [...new Set(tokenize([request.question, ...request.terms].join(" ")))]
		const restrictedBestTermMatch =
			(await this.vectorStore.bestTermMatchOutsideScope?.([request.question, ...request.terms], filter)) ?? 0
		const allowedBestTermMatch = chunks.slice(0, 3).reduce((best, chunk) => {
			const haystack = `${chunk.documentTitle} ${chunk.section} ${chunk.text}`.toLowerCase()
			const matched = probeTerms.filter((term) => haystack.includes(term)).length
			return Math.max(best, matched)
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
				restrictedBestTermMatch,
				allowedBestTermMatch,
				departmentsSearched: [...new Set(candidates.map((c) => c.department))],
			},
		}
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		return this.vectorStore.healthCheck()
	}
}
