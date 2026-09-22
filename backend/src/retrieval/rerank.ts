/**
 * Re-ranking stage: fuses hybrid scores with metadata signals and enforces
 * source diversity so one long document cannot crowd out the answer.
 */
import { CLASSIFICATION_LEVEL } from "../models/types.ts"
import type { RetrievedChunk } from "../models/types.ts"

export type RerankSignals = {
	vectorWeight: number
	keywordWeight: number
	/** Department of the asking user - small affinity boost, never a hard filter. */
	userDepartment?: string
	/** Departments inferred from the question by query understanding. */
	hintedDepartments?: string[]
	hintedCategories?: string[]
	maxPerDocument?: number
}

export function rerank(candidates: RetrievedChunk[], signals: RerankSignals, topK: number): RetrievedChunk[] {
	const scored = candidates.map((chunk) => {
		let score = signals.vectorWeight * chunk.vectorScore + signals.keywordWeight * chunk.keywordScore
		if (signals.hintedDepartments?.includes(chunk.department)) score += 0.12
		if (signals.hintedCategories?.includes(chunk.category)) score += 0.05
		if (signals.userDepartment && chunk.department === signals.userDepartment) score += 0.03
		// Prefer the least sensitive source that answers the question.
		score -= 0.01 * (CLASSIFICATION_LEVEL[chunk.classification] - 1)
		// Titles/headings that match the query already boosted via keywordScore;
		// early sections of a policy tend to hold the normative statements.
		if (chunk.seq === 0) score += 0.01
		return { ...chunk, score }
	})

	scored.sort((a, b) => b.score - a.score)

	const maxPerDocument = signals.maxPerDocument ?? 3
	const perDocument = new Map<string, number>()
	const picked: RetrievedChunk[] = []
	for (const chunk of scored) {
		const used = perDocument.get(chunk.documentId) ?? 0
		if (used >= maxPerDocument) continue
		perDocument.set(chunk.documentId, used + 1)
		picked.push(chunk)
		if (picked.length >= topK) break
	}
	return picked
}
// hist: 2026-09-22T16:21:15+05:30
