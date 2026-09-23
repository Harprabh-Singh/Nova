/**
 * Phrases that mean "I did not actually answer this".
 *
 * Both the hosted model (instructed to refuse with a fixed sentence) and the
 * deterministic local composer can produce a reply that reads like a miss. The
 * old code matched only ONE wording, so the local composer's "none of them
 * directly answer that / I'd be guessing" reply sailed through as a successful
 * answer - which is why "Grounded - high" got stamped on top of a visible
 * non-answer, with a citation attached.
 *
 * Single source of truth: the knowledge agent uses this to force
 * insufficient_evidence, confidence none, and zero citations.
 */
export const HEDGE_PATTERNS: RegExp[] = [
	/couldn'?t verify this from the available/i,
	/could not verify this from the available/i,
	/none of (them|the documents|these documents) directly answer/i,
	/i'?d be guessing/i,
	/i would be guessing/i,
	/no document you'?re cleared to see covers/i,
	/the evidence (provided )?does not answer/i,
	/not covered (by|in) (the|any) (available|authori[sz]ed) (document|evidence)/i,
]

export const HEDGE_PATTERN = new RegExp(HEDGE_PATTERNS.map((r) => r.source).join("|"), "i")

/** True when a composed answer is really a non-answer. */
export function isHedgedAnswer(text: string): boolean {
	return HEDGE_PATTERN.test(text)
}
