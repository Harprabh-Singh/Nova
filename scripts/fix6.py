import pathlib
root = pathlib.Path("/data/nova")

# --- A. Distinctive-term coverage gate in the knowledge agent ---------------
p = root / "backend/src/agents/knowledgeAgent.ts"
s = p.read_text()

old = """		// Grounding gate: a similarity score alone is not evidence. The retrieved
		// evidence must also share meaningful vocabulary with the question, otherwise
		// the nearest-neighbour chunk is simply the least-bad match in the corpus.
		const evidenceText = retrieval.chunks
			.map((c) => `${c.documentTitle} ${c.section} ${c.text}`)
			.join(" ")
			.toLowerCase()
		const contentTerms = understanding.terms.filter((t) => t.length > 3)
		const matchedTerms = contentTerms.filter((t) => evidenceText.includes(t.toLowerCase()))
		const overlapRatio = contentTerms.length === 0 ? 1 : matchedTerms.length / contentTerms.length
		const offTopic = contentTerms.length >= 3 && overlapRatio < 0.4
"""
new = """		// Grounding gate. A similarity score alone is not evidence: the nearest
		// neighbour of an out-of-scope question is still the least-bad chunk in the
		// corpus. We therefore require the *distinctive* words of the question (the
		// rare ones, by corpus document frequency) to actually appear in the best
		// evidence. This is what stops confident answers to questions the knowledge
		// base does not cover, and it is company- and industry-neutral.
		const offTopic = this.isOffTopic(tenant.id, understanding.terms, retrieval.chunks)
"""
assert old in s
s = s.replace(old, new, 1)

# add the helper method right after the constructor closing
anchor = "	async answer(request: AnswerRequest): Promise<AnswerResult> {"
helper = """	/**
	 * True when the question's distinctive vocabulary is missing from the best
	 * retrieved evidence. Distinctiveness is measured against the tenant's own
	 * corpus, so no company-specific term list is required.
	 */
	private isOffTopic(tenantId: string, terms: string[], chunks: RetrievedChunk[]): boolean {
		if (chunks.length === 0) return false
		const candidates = [...new Set(terms.filter((t) => t.length > 4))]
		if (candidates.length < 2) return false

		const totalRow = this.db.get(
			`SELECT COUNT(*) AS n FROM document_chunks c
			 JOIN document_versions v ON v.id = c.version_id AND v.status = 'active'
			 WHERE c.tenant_id = ?`,
			tenantId,
		)
		const totalChunks = Number(totalRow?.n ?? 0)
		if (totalChunks === 0) return false

		// Distinctive = rare in the corpus (or absent from it entirely).
		const distinctive = candidates.filter((term) => {
			const row = this.db.get(
				`SELECT COUNT(*) AS n FROM document_chunks c
				 JOIN document_versions v ON v.id = c.version_id AND v.status = 'active'
				 WHERE c.tenant_id = ? AND lower(c.text) LIKE ?`,
				tenantId,
				`%${term.toLowerCase()}%`,
			)
			return Number(row?.n ?? 0) <= Math.max(1, totalChunks * 0.2)
		})
		if (distinctive.length < 2) return false

		const best = chunks
			.slice(0, 3)
			.map((c) => `${c.documentTitle} ${c.section} ${c.text}`)
			.join(" ")
			.toLowerCase()
		const covered = distinctive.filter((term) => best.includes(term.toLowerCase()))
		return covered.length / distinctive.length < 0.5
	}

	async answer(request: AnswerRequest): Promise<AnswerResult> {"""
assert anchor in s
s = s.replace(anchor, helper, 1)
p.write_text(s)
print("ok knowledgeAgent")

# --- B. Extractive composer: prefer concise, on-topic, highly ranked evidence
p2 = root / "backend/src/llm/local.ts"
s2 = p2.read_text()
old2 = """		const scored: Array<{ ref: string; sentence: string; score: number; title: string; section: string }> = []
		for (const item of evidence) {"""
new2 = """		const scored: Array<{ ref: string; sentence: string; score: number; title: string; section: string }> = []
		// Only the best-ranked evidence items may contribute sentences, and their
		// contribution decays with rank, so a weak match cannot dominate the answer.
		for (const [rank, item] of evidence.slice(0, 4).entries()) {
			const rankWeight = 1 / (1 + rank * 0.5)"""
assert old2 in s2
s2 = s2.replace(old2, new2, 1)

old3 = """				const quantitative = /\\d/.test(sentence) ? 0.35 : 0
				const score = overlap / Math.sqrt(sentenceTerms.length) + quantitative
				if (overlap > 0) {"""
new3 = """				// Quantitative sentences answer "how many / how long / how much" questions.
				const quantitative = /\\d/.test(sentence) ? 0.2 : 0
				// Long pasted tables are rarely the answer to a specific question.
				const verbosityPenalty = sentence.length > 320 ? 0.5 : 1
				const score = (overlap / Math.sqrt(sentenceTerms.length) + quantitative) * rankWeight * verbosityPenalty
				if (overlap >= (sentence.length > 240 ? 2 : 1)) {"""
assert old3 in s2
s2 = s2.replace(old3, new3, 1)
p2.write_text(s2)
print("ok llm/local")
"""
"""
