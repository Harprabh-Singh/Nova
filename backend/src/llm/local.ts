/**
 * LocalLLMProvider.
 *
 * 1. If LOCAL_LLM_BASE_URL is configured, calls that OpenAI-compatible endpoint
 *    (Ollama / llama.cpp / LM Studio / vLLM ...). No cloud, no paid API.
 * 2. Otherwise falls back to a deterministic reasoning composer that parses
 *    the question's intent (yes/no + amount checks, how-to, definitions,
 *    quantities), reasons over the evidence (limits, thresholds, numbers),
 *    and synthesizes a prose answer in DOCUMENT order. It never invents
 *    company facts, and every response is labelled as a fallback in the API.
 */
import type { ChatMessage, CompletionRequest, CompletionResult, LLMProvider } from "./base.ts"
import { log } from "../observability/logger.ts"

export type LocalLlmOptions = {
	baseUrl: string
	model: string
	apiKey?: string
	timeoutMs?: number
}

const STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "of", "for", "to", "in", "on", "and", "or", "our",
	"what", "which", "who", "how", "do", "does", "did", "i", "we", "can", "should", "my", "me",
	"this", "that", "it", "be", "with", "about", "at", "as", "by", "from", "if", "any", "there",
	"when", "then", "they", "them", "their", "you", "your", "yours", "he", "she", "his", "her",
])

function terms(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9₹%.\- ]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 2 && !STOP_WORDS.has(t))
}

/** Split evidence into sentences, preserving each sentence's position so
 *  procedural answers can be reassembled in the order the document has them. */
function splitSentences(text: string): string[] {
	return text
		.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z₹0-9*])|\n(?=[-*\d])/g)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length > 24)
}

/** Strip markdown emphasis/numbering artifacts from a quoted sentence. */
function cleanSentence(s: string): string {
	return s
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^[-*]\s+/, "")
		.trim()
}

/** Pull the actual question out of the composed user turn.
 *  The knowledge agent wraps the question as `<EVIDENCE>…</EVIDENCE>\n\nQuestion from <name>: <q>`
 *  — scoring against that whole blob made every evidence sentence "match" itself. */
function extractQuestion(raw: string): string {
	const match = raw.match(/Question from [^:]+:\s*([\s\S]*)$/)
	return (match ? match[1] : raw).trim()
}

/** Parse amounts incl. Indian conventions: ₹80,000 / 2 lakh / 1 crore / 50k. */
function extractAmounts(text: string): number[] {
	const out: number[] = []
	for (const m of text.matchAll(/(?:₹|rs\.?|inr|\$|usd|€)?\s*([\d][\d,]*(?:\.\d+)?)\s*(lakh|lac|crore|cr|k)\b/gi)) {
		const base = Number(m[1].replace(/,/g, ""))
		if (!Number.isFinite(base)) continue
		const unit = m[2].toLowerCase()
		out.push(unit === "k" ? base * 1_000 : unit === "crore" || unit === "cr" ? base * 10_000_000 : base * 100_000)
	}
	for (const m of text.matchAll(/(?:₹|rs\.?|inr|\$|usd|€)\s*([\d][\d,]*(?:\.\d+)?)/gi)) {
		const value = Number(m[1].replace(/,/g, ""))
		if (Number.isFinite(value)) out.push(value)
	}
	return [...new Set(out)]
}

function formatAmount(value: number): string {
	return "₹" + value.toLocaleString("en-IN")
}

type Scored = {
	ref: string
	sentence: string
	score: number
	title: string
	section: string
	version: string
	amounts: number[]
	position: number // sentence index within its document — restores document order
}

export class LocalLLMProvider implements LLMProvider {
	readonly name = "LocalLLMProvider"
	readonly mode = "local" as const

	constructor(private readonly options: LocalLlmOptions) {}

	get model(): string {
		return this.options.baseUrl ? this.options.model : "nova-reasoning-fallback-v2"
	}

	get hasRealModel(): boolean {
		return Boolean(this.options.baseUrl)
	}

	async complete(request: CompletionRequest): Promise<CompletionResult> {
		const started = Date.now()
		if (this.options.baseUrl) {
			try {
				return await this.callOpenAiCompatible(request, started)
			} catch (error) {
				log.warn("llm.local.endpoint_failed", { detail: (error as Error).message })
				return this.composeFallback(request, started, `local model endpoint unavailable: ${(error as Error).message}`)
			}
		}
		return this.composeFallback(request, started, "no local model configured (LOCAL_LLM_BASE_URL is empty)")
	}

	private async callOpenAiCompatible(request: CompletionRequest, started: number): Promise<CompletionResult> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000)
		try {
			const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"content-type": "application/json",
					...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: this.options.model,
					messages: request.messages satisfies ChatMessage[],
					temperature: request.temperature ?? 0.1,
					max_tokens: request.maxTokens ?? 800,
					stream: false,
				}),
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			const data = (await response.json()) as any
			const text = data?.choices?.[0]?.message?.content?.trim()
			if (!text) throw new Error("empty completion")
			return {
				text,
				provider: `local:${this.options.baseUrl}`,
				model: this.options.model,
				isFallback: false,
				usage: {
					promptTokens: data?.usage?.prompt_tokens,
					completionTokens: data?.usage?.completion_tokens,
				},
				latencyMs: Date.now() - started,
			}
		} finally {
			clearTimeout(timer)
		}
	}

	/**
	 * Deterministic reasoning composer. Instead of quoting whatever chunks
	 * retrieval returned, it:
	 *   1. extracts the real question (never the evidence envelope),
	 *   2. classifies intent (yes/no + amounts, how-to, definition, quantity),
	 *   3. reasons over evidence — comparing the question's amounts against
	 *      documented limits, or reassembling steps in document order,
	 *   4. answers honestly when the evidence doesn't actually cover it.
	 */
	private composeFallback(request: CompletionRequest, started: number, reason: string): CompletionResult {
		const done = (text: string): CompletionResult => ({
			text,
			provider: "local-fallback-reasoning",
			model: this.model,
			isFallback: true,
			fallbackReason: reason,
			latencyMs: Date.now() - started,
		})

		const rawUser = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? ""
		const question = extractQuestion(rawUser)
		const questionTerms = new Set(terms(question))

		// Short follow-ups ("and for 2 lakh?", "what about contractors?") inherit
		// the previous question's vocabulary so retrieval scoring has context.
		if (questionTerms.size <= 3) {
			const previousUsers = request.messages.filter((m) => m.role === "user").slice(0, -1)
			const previous = previousUsers.length ? extractQuestion(previousUsers[previousUsers.length - 1].content) : ""
			for (const t of terms(previous)) questionTerms.add(t)
		}

		const evidence = request.evidence ?? []
		if (evidence.length === 0) {
			return done(
				"I don't have anything on that in the documents you're cleared to see. " +
					"Try asking about a specific policy, SOP, approval limit or procedure — or say \"what can you do\" to see what I cover.",
			)
		}

		// --- score evidence sentences against the REAL question -------------
		const scored: Scored[] = []
		for (const [rank, item] of evidence.slice(0, 5).entries()) {
			const rankWeight = 1 / (1 + rank * 0.6)
			const sentences = splitSentences(item.text)
			for (const [position, raw] of sentences.entries()) {
				const sentence = cleanSentence(raw)
				const sentenceTerms = terms(sentence)
				if (sentenceTerms.length === 0) continue
				let overlap = 0
				for (const t of new Set(sentenceTerms)) if (questionTerms.has(t)) overlap += 1
				const quantitative = /\d/.test(sentence) ? 0.2 : 0
				const verbosityPenalty = sentence.length > 320 ? 0.45 : 1
				const score = (overlap / Math.sqrt(sentenceTerms.length) + quantitative) * rankWeight * verbosityPenalty
				if (overlap >= (sentence.length > 240 ? 2 : 1)) {
					scored.push({
						ref: item.ref,
						sentence,
						score,
						title: item.documentTitle,
						section: item.section,
						version: item.version,
						amounts: extractAmounts(sentence),
						position,
					})
				}
			}
		}
		scored.sort((a, b) => b.score - a.score)

		const seen = new Set<string>()
		const picked = scored
			.filter((item) => {
				const key = item.sentence.trim().toLowerCase()
				if (seen.has(key)) return false
				seen.add(key)
				return true
			})
			.slice(0, 5)

		const questionAmounts = extractAmounts(question).filter((n) => n >= 1)
		const isYesNo = /^(can|could|may|am i|is it|are we|do i|do we|should i|would i|will i)\b/i.test(question)
		// "what is our machine failure procedure?", "escalation process for a
		// breakdown", "SOP for downtime" are all step questions too - the old
		// anchored pattern only caught "how do I..." and "steps to...".
		const wantsSteps =
			/^(how (do|can|to)|steps? (to|for)|process (to|of|for)|procedure (to|for)|what('s| is) the (process|procedure|steps))/i.test(question) ||
			/\b(procedure|process|protocol|sop|steps|workflow|escalation|checklist)\b/i.test(question)

		// --- reasoning path: yes/no question carrying an amount -------------
		if (isYesNo && questionAmounts.length > 0) {
			const limitHit = picked.find(
				(s) =>
					s.amounts.some((a) => a >= 100) &&
					/(limit|up to|maximum|max\b|cap(ped)?|threshold|authority|approval|approve|delegate|exceed|not more than|within|per (transaction|purchase|claim|request))/i.test(
						s.sentence,
					),
			)
			if (limitHit) {
				const limit = Math.max(...limitHit.amounts.filter((a) => a >= 100))
				const asked = Math.max(...questionAmounts)
				const allowed = asked <= limit
				const escalation = picked.find(
					(s) => s !== limitHit && /(escalat|finance head|cfo|approval from|sign-off from|next level|higher authority)/i.test(s.sentence),
				)
				const lines = [
					allowed
						? `Yes — ${formatAmount(asked)} is within the documented limit. ${limitHit.sentence} [${limitHit.ref}]`
						: `No — ${formatAmount(asked)} is above the documented limit of ${formatAmount(limit)}. ${limitHit.sentence} [${limitHit.ref}]`,
				]
				if (escalation) lines.push("", `${escalation.sentence} [${escalation.ref}]`)
				lines.push("", `Source: ${limitHit.title} (${limitHit.section || "general"}, v${limitHit.version}).`)
				return done(lines.join("\n"))
			}
		}

		// --- no sentence shares real vocabulary with the question -----------
		// Threshold note: the local composer scores term overlap, which runs low
		// on multi-word domain phrases ("machine failure procedure"). Hedging at
		// 0.25 threw away genuinely relevant evidence and printed a non-answer on
		// top of six real chunks. Only bail when nothing overlaps at all.
		if (picked.length === 0 || picked[0].score < 0.1) {
			const first = evidence[0]
			return done(
				"I looked through the documents you're cleared to see and none of them directly answer that. " +
					`The closest material is "${first.documentTitle}" (${first.section || "general section"}, v${first.version}) [${first.ref}], ` +
					"but I'd be guessing if I answered from it. Try rephrasing with the policy or topic name, or ask \"what can you do\".",
			)
		}

		// --- synthesis path ---------------------------------------------------
		const top = picked[0]
		const parts: string[] = []

		if (wantsSteps) {
			// Reassemble steps in the DOCUMENT's order (by ref + sentence position),
			// not by match score — and renumber them 1, 2, 3 … ourselves so the
			// answer never starts at "3." just because the top match came first.
			const fromTopDoc = picked.filter((p) => p.ref === top.ref || p.title === top.title)
			const ordered = (fromTopDoc.length >= 2 ? fromTopDoc : picked)
				.slice(0, 5)
				.sort((a, b) => (a.ref === b.ref ? a.position - b.position : Number(a.ref) - Number(b.ref)))
			parts.push(`Here's the documented process, per "${top.title}":`, "")
			ordered.forEach((p, i) => parts.push(`${i + 1}. ${p.sentence} [${p.ref}]`))
		} else {
			parts.push(`${top.sentence} [${top.ref}]`)
			for (const p of picked.slice(1, 3)) parts.push("", `${p.sentence} [${p.ref}]`)
		}

		parts.push("", `Source: ${top.title} (${top.section || "general"}, v${top.version}).`)
		return done(parts.join("\n"))
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string; model?: string }> {
		if (!this.options.baseUrl) {
			return {
				ok: true,
				detail: "Local deterministic reasoning composer (no model server configured). Answers are labelled FALLBACK.",
				model: this.model,
			}
		}
		try {
			const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/models`, {
				headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
			})
			return response.ok
				? { ok: true, detail: `Local model server reachable at ${this.options.baseUrl}`, model: this.options.model }
				: { ok: false, detail: `Local model server returned HTTP ${response.status}`, model: this.options.model }
		} catch (error) {
			return {
				ok: false,
				detail: `Local model server unreachable (${(error as Error).message}); using labelled fallback composer.`,
				model: this.model,
			}
		}
	}
}
