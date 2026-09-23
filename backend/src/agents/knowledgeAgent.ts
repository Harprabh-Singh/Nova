/**
 * KnowledgeAgent - the RAG orchestrator.
 *
 *   question -> identity/tenant -> query understanding -> authorization filter
 *   -> hybrid retrieval -> re-rank -> evidence envelope -> LLM -> grounded
 *   answer -> verified citations
 */
import type { Database } from "../db/index.ts"
import type { KnowledgeProvider } from "../knowledge/base.ts"
import type { LLMProvider, EvidenceItem } from "../llm/base.ts"
import { LLMError } from "../llm/base.ts"
import type { AccessScope } from "../authorization/policy.ts"
import type { Citation, Confidence, Grounding, RetrievedChunk, Tenant, User } from "../models/types.ts"
import { understandQuery } from "./queryUnderstanding.ts"
import { buildSystemPrompt, renderEvidence } from "./prompt.ts"
import { neutralizeForContext, detectUserAttack } from "../documents/injection.ts"
import { buildCitations, reconcileCitations } from "../citations/index.ts"
import { classifyUnanswered, sanitizeReply } from "./general.ts"
import { HEDGE_PATTERN } from "./hedges.ts"
import { log } from "../observability/logger.ts"

export type AnswerRequest = {
	tenant: Tenant
	user: User
	scope: AccessScope
	question: string
	history?: Array<{ role: "user" | "assistant"; content: string }>
	requestId: string
}

export type AnswerResult = {
	answer: string
	grounding: Grounding
	confidence: Confidence
	citations: Citation[]
	provider: string
	model: string
	isFallback: boolean
	fallbackReason?: string
	latencyMs: number
	/**
	 * True when nothing in the authorised corpus addresses the question. The API
	 * layer uses this to hand general turns to the general assistant instead of
	 * printing a refusal.
	 */
	outOfScope: boolean
	retrieval: {
		provider: string
		candidateCount: number
		usedCount: number
		embeddingModel: string
		departmentsSearched: string[]
		restrictedMatches: number
		latencyMs: number
		topScore: number
	}
	security: {
		userAttackFlags: string[]
		documentInjectionFlags: string[]
		fabricatedCitationMarkers: number[]
		accessDenied: boolean
	}
}

const ACCESS_DENIED_MESSAGE =
	"ACCESS DENIED\n\nYour current role does not have permission to access this information."

/** Score thresholds for the grounding/confidence labels. */
const HIGH_SCORE = 0.42
const MEDIUM_SCORE = 0.2

export class KnowledgeAgent {
	constructor(
		private readonly db: Database,
		private readonly knowledge: KnowledgeProvider,
		private readonly llm: LLMProvider,
	) {}

	/**
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
		if (distinctive.length === 0) return false

		const best = chunks
			.slice(0, 3)
			.map((c) => `${c.documentTitle} ${c.section} ${c.text}`)
			.join(" ")
			.toLowerCase()
		const covered = distinctive.filter((term) => best.includes(term.toLowerCase()))
		// None of the question's rare words present = the evidence is about
		// something else, however high its similarity score happened to be.
		return covered.length === 0
	}

	async answer(request: AnswerRequest): Promise<AnswerResult> {
		const started = Date.now()
		const { tenant, user, scope } = request

		// 1. User-side injection / extraction attempts are flagged but the request
		//    still proceeds: the defence is the prompt envelope + authorization.
		const userAttackFlags = detectUserAttack(request.question)

		// 2. Query understanding (tenant taxonomy aware, no company hard-coding).
		const understanding = understandQuery(this.db, tenant.id, request.question)

		// 3+4+5. Authorization-filtered hybrid retrieval and re-ranking.
		const retrieval = await this.knowledge.retrieve({
			question: understanding.normalized,
			terms: understanding.terms,
			hintedDepartments: understanding.hintedDepartments,
			hintedCategories: understanding.hintedCategories,
			scope,
		})

		const topScore = retrieval.chunks[0]?.score ?? 0
		const documentInjectionFlags = [...new Set(retrieval.chunks.flatMap((c) => c.injectionFlags))]

		// 6. Nothing authorized matched, but restricted material did: this is an
		//    authorization outcome, not a knowledge gap. We never name the document.
		// Grounding gate. A similarity score alone is not evidence: the nearest
		// neighbour of an out-of-scope question is still the least-bad chunk in the
		// corpus. We therefore require the *distinctive* words of the question (the
		// rare ones, by corpus document frequency) to actually appear in the best
		// evidence. This is what stops confident answers to questions the knowledge
		// base does not cover, and it is company- and industry-neutral.
		const offTopic = this.isOffTopic(tenant.id, understanding.terms, retrieval.chunks)

		const nothingUseful = retrieval.chunks.length === 0 || topScore < MEDIUM_SCORE * 0.5
		// Denial applies when the authorized evidence cannot address the question
		// (nothing useful, or none of the question's distinctive words appear in it)
		// while material beyond the caller's clearance did match.
		// The question is better answered by material the caller may not see than by
		// anything they may see: that is an authorization outcome, not a knowledge gap.
		const restrictedIsBetterMatch =
			(retrieval.diagnostics.restrictedBestTermMatch ?? 0) > (retrieval.diagnostics.allowedBestTermMatch ?? 0)
		if ((nothingUseful || offTopic || restrictedIsBetterMatch) && retrieval.diagnostics.restrictedMatches > 0) {
			log.info("chat.access_denied", {
				requestId: request.requestId,
				tenantId: tenant.id,
				userId: user.id,
				restrictedMatches: retrieval.diagnostics.restrictedMatches,
			})
			return {
				answer: ACCESS_DENIED_MESSAGE,
				grounding: "access_denied",
				confidence: "none",
				citations: [],
				provider: "authorization",
				model: "n/a",
				isFallback: false,
				latencyMs: Date.now() - started,
				outOfScope: false,
				retrieval: {
					provider: retrieval.diagnostics.provider,
					candidateCount: retrieval.diagnostics.candidateCount,
					usedCount: 0,
					embeddingModel: retrieval.diagnostics.embeddingModel,
					departmentsSearched: retrieval.diagnostics.departmentsSearched,
					restrictedMatches: retrieval.diagnostics.restrictedMatches,
					latencyMs: retrieval.diagnostics.latencyMs,
					topScore: 0,
				},
				security: {
					userAttackFlags,
					documentInjectionFlags: [],
					fabricatedCitationMarkers: [],
					accessDenied: true,
				},
			}
		}

		// 7. Build the evidence envelope. Injection payloads inside documents are
		//    neutralised; the envelope marks all of it as untrusted data.
		const evidence: EvidenceItem[] = retrieval.chunks.map((chunk, i) => ({
			ref: String(i + 1),
			documentTitle: chunk.documentTitle,
			department: chunk.department,
			version: chunk.version,
			section: chunk.section,
			text: neutralizeForContext(chunk.text).text,
		}))

		const userContext = [
			`- Name: ${user.name}`,
			`- Role: ${user.roleKey}`,
			`- Department: ${user.department}`,
			`- Title: ${user.title}`,
		].join("\n")

		const history = (request.history ?? []).slice(-6)
		const messages = [
			{ role: "system" as const, content: buildSystemPrompt(tenant, userContext) },
			...history,
			{
				role: "user" as const,
				content: `${renderEvidence(evidence)}\n\nQuestion from ${user.name}: ${understanding.normalized}`,
			},
		]

		// 8. Model call through the provider abstraction only.
		let completion
		try {
			completion = await this.llm.complete({ messages, evidence, temperature: 0.1 })
		} catch (error) {
			const detail = error instanceof LLMError ? error.message : "model provider failure"
			log.error("chat.llm_failed", { requestId: request.requestId, tenantId: tenant.id, detail })
			return {
				answer:
					"The answering model is currently unavailable, so I can't produce a grounded answer. Please retry shortly.",
				grounding: "insufficient_evidence",
				confidence: "none",
				citations: [],
				provider: this.llm.name,
				model: this.llm.model,
				isFallback: false,
				fallbackReason: detail,
				latencyMs: Date.now() - started,
				outOfScope: false,
				retrieval: {
					provider: retrieval.diagnostics.provider,
					candidateCount: retrieval.diagnostics.candidateCount,
					usedCount: retrieval.chunks.length,
					embeddingModel: retrieval.diagnostics.embeddingModel,
					departmentsSearched: retrieval.diagnostics.departmentsSearched,
					restrictedMatches: retrieval.diagnostics.restrictedMatches,
					latencyMs: retrieval.diagnostics.latencyMs,
					topScore,
				},
				security: { userAttackFlags, documentInjectionFlags, fabricatedCitationMarkers: [], accessDenied: false },
			}
		}

		// 9. Citations are reconciled against real retrieved chunks only.
		//    Cap to the strongest chunks so weak retrievals can't dump a wall
		//    of irrelevant sources under the answer.
		const citableChunks = retrieval.chunks.filter((_, i) => i < 6)
		const allCitations = buildCitations(citableChunks)
		const reconciled = reconcileCitations(completion.text, allCitations)

		// A composed answer that hedges - "none of them directly answer that",
		// "I'd be guessing", "couldn't verify" - is NOT a grounded answer, however
		// high the similarity score was. This is what used to print
		// "Grounded / high" on top of a visible non-answer.
		const unverifiable = HEDGE_PATTERN.test(reconciled.answer)

		// A weak top score with no shared vocabulary means the question is
		// casual chatter or simply not an enterprise topic — never let that
		// surface as a "partially grounded" document answer.
		const bestText = retrieval.chunks
			.slice(0, 3)
			.map((c) => `${c.documentTitle} ${c.section} ${c.text}`)
			.join(" ")
			.toLowerCase()
		const meaningfulTerms = understanding.terms.filter((t) => t.length > 3)
		const corpusEcho = meaningfulTerms.some((t) => bestText.includes(t.toLowerCase()))
		// CRITICAL: "that's outside my lane" is only ever correct for genuinely
		// off-domain chatter (food, movies, trivia). A question like "what is our
		// machine failure procedure?" is unmistakably company work, so even when
		// the local embeddings score it weakly it must NEVER get the off-domain
		// brush-off - at worst it gets the honest "no document covers this yet".
		const companyFlavoured = classifyUnanswered(request.question) === "company"
		const casualOrOutOfScope = !companyFlavoured && (offTopic || (topScore < MEDIUM_SCORE * 0.6 && !corpusEcho))

		let grounding: Grounding
		let confidence: Confidence
		if (retrieval.chunks.length === 0 || unverifiable || casualOrOutOfScope) {
			grounding = "insufficient_evidence"
			confidence = "none"
		} else if (topScore >= HIGH_SCORE && reconciled.citations.length > 0) {
			grounding = "grounded"
			confidence = "high"
		} else if (topScore >= MEDIUM_SCORE) {
			grounding = "grounded"
			confidence = "medium"
		} else {
			grounding = "partially_grounded"
			confidence = "low"
		}

		// Guard against greeting the user with the company's name: seeded demo
		// accounts are often called things like "Acme Admin".
		const nameHead = user.name.split(/\s+/)[0] || user.name
		const tenantHead = tenant.name.split(/\s+/)[0] ?? ""
		const firstName = nameHead.toLowerCase() === tenantHead.toLowerCase() ? (user.name.split(/\s+/)[1] ?? "there") : nameHead
		const assistantName = tenant.settings.assistantName || "NOVA"
		// Off-domain (burgers, movies, weather, random chit-chat): a friendly,
		// honest refusal that steers back to work — never fake document answers.
		const outOfScopeAnswer = [
			`Ha, that's a bit outside my lane, ${firstName} 🙂`,
			"",
			`I'm ${assistantName} — I answer from ${tenant.name}'s own documents: policies, SOPs, approvals, leave, benefits, safety, incidents. Things like food, entertainment or general trivia aren't in my library, so I won't pretend to know.`,
			"",
			`But anything about work at ${tenant.name}? Ask away.`,
		].join("\n")
		// On-domain but missing docs: helpful and actionable.
		const helpfulMiss = [
			`I couldn't verify this from the available ${tenant.name} knowledge — no document you're cleared to see covers it yet.`,
			"",
			...(retrieval.chunks.length > 0
				? [`The closest thing I found was "${retrieval.chunks[0].documentTitle}"${retrieval.chunks[0].section ? ` (${retrieval.chunks[0].section})` : ""}, but it doesn't actually answer this.`, ""]
				: []),
			"A few things you can try:",
			"• Rephrase with the exact policy or topic name (e.g. \"leave policy\", \"approval matrix\").",
			"• Ask me \"what can you do\" to see the areas I can answer from.",
			"• If a document is missing, ask an admin to upload it in the knowledge library.",
		].join("\n")

		const unanswered = grounding === "insufficient_evidence"
		const answer = unanswered ? (casualOrOutOfScope ? outOfScopeAnswer : helpfulMiss) : sanitizeReply(reconciled.answer)

		return {
			answer,
			grounding,
			confidence,
			citations: unanswered ? [] : reconciled.citations,
			outOfScope: unanswered,
			provider: completion.provider,
			model: completion.model,
			isFallback: completion.isFallback,
			fallbackReason: completion.fallbackReason,
			latencyMs: Date.now() - started,
			retrieval: {
				provider: retrieval.diagnostics.provider,
				candidateCount: retrieval.diagnostics.candidateCount,
				usedCount: retrieval.chunks.length,
				embeddingModel: retrieval.diagnostics.embeddingModel,
				departmentsSearched: retrieval.diagnostics.departmentsSearched,
				restrictedMatches: retrieval.diagnostics.restrictedMatches,
				latencyMs: retrieval.diagnostics.latencyMs,
				topScore: Number(topScore.toFixed(4)),
			},
			security: {
				userAttackFlags,
				documentInjectionFlags,
				fabricatedCitationMarkers: reconciled.fabricatedMarkers,
				accessDenied: false,
			},
		}
	}
}
