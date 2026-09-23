/**
 * Citations are derived ONLY from chunks that were actually retrieved and
 * actually passed to the model. A citation can never be invented by the model:
 * the model references evidence by number, and we map numbers back to records.
 */
import type { Citation, RetrievedChunk } from "../models/types.ts"

export function buildCitations(chunks: RetrievedChunk[]): Citation[] {
	return chunks.map((chunk, index) => ({
		index: index + 1,
		chunkId: chunk.chunkId,
		documentId: chunk.documentId,
		versionId: chunk.versionId,
		documentTitle: chunk.documentTitle,
		department: chunk.department,
		version: chunk.version,
		section: chunk.section,
		classification: chunk.classification,
		score: Number(chunk.score.toFixed(4)),
	}))
}

/**
 * Keeps only citations the answer text actually referenced, and verifies every
 * referenced marker maps to a real retrieved chunk. Unknown markers are dropped
 * from the text so a fabricated reference can never reach the UI.
 */
export function reconcileCitations(
	answer: string,
	citations: Citation[],
): { answer: string; citations: Citation[]; fabricatedMarkers: number[] } {
	const referenced = new Set<number>()
	const fabricated: number[] = []
	const valid = new Set(citations.map((c) => c.index))

	const cleaned = answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, group: string) => {
		const numbers = group.split(/\s*,\s*/).map((n) => Number(n))
		const keep = numbers.filter((n) => valid.has(n))
		numbers.filter((n) => !valid.has(n)).forEach((n) => fabricated.push(n))
		keep.forEach((n) => referenced.add(n))
		return keep.length ? `[${keep.join(", ")}]` : ""
	})

	// If the model cited nothing explicitly, keep all supporting evidence so the
	// user can still audit the answer.
	const used = referenced.size > 0 ? citations.filter((c) => referenced.has(c.index)) : citations
	return { answer: cleaned.replace(/[ \t]{2,}/g, " ").trim(), citations: used, fabricatedMarkers: fabricated }
}
