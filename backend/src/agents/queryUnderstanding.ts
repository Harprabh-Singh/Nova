/**
 * Query understanding: expands the question into retrieval terms and infers
 * department/category hints from the tenant's OWN taxonomy (departments and
 * categories are read from the database, never hard-coded to a company).
 */
import type { Database } from "../db/index.ts"
import { tokenize } from "../embeddings/local.ts"
import { detectSmalltalk } from "./smalltalk.ts"

export type QueryUnderstanding = {
	normalized: string
	terms: string[]
	hintedDepartments: string[]
	hintedCategories: string[]
	intent: "knowledge" | "action.incident" | "smalltalk"
	amounts: number[]
	machineIds: string[]
}

/** Domain-neutral synonym expansion (no company or industry specifics). */
const SYNONYMS: Record<string, string[]> = {
	approve: ["approval", "authorize", "sign-off", "threshold"],
	approval: ["approve", "authority", "threshold", "matrix"],
	purchase: ["procurement", "buy", "purchasing", "capital", "expenditure"],
	leave: ["vacation", "time off", "holiday", "absence", "annual leave"],
	holiday: ["leave", "vacation"],
	breakdown: ["failure", "fault", "malfunction", "downtime"],
	malfunction: ["failure", "breakdown", "fault"],
	failure: ["breakdown", "malfunction", "fault", "stoppage"],
	escalate: ["escalation", "notify", "severity"],
	incident: ["report", "event", "injury", "accident"],
	expense: ["reimbursement", "claim", "spend"],
	salary: ["compensation", "pay", "remuneration", "pay band"],
	deploy: ["deployment", "release", "rollout"],
	security: ["information security", "access control"],
	onboarding: ["new hire", "induction"],
	sop: ["standard operating procedure", "procedure"],
	policy: ["policies", "guideline", "standard"],
}

const ACTION_PATTERNS = [
	/\b(report|raise|log|file|create|open)\b[^.?!]{0,40}\b(incident|breakdown|failure|malfunction|ticket)\b/i,
	/\b(machine|equipment|asset|line)\b[^.?!]{0,40}\b(down|failed|malfunction\w*|broken|stopped)\b/i,
	/help me report/i,
]

export function understandQuery(db: Database, tenantId: string, question: string): QueryUnderstanding {
	const normalized = question.trim().replace(/\s+/g, " ")
	const lower = normalized.toLowerCase()
	const baseTerms = tokenize(normalized)

	const expanded = new Set<string>(baseTerms)
	for (const token of baseTerms) {
		for (const [key, values] of Object.entries(SYNONYMS)) {
			if (token.startsWith(key.slice(0, Math.max(4, key.length - 2)))) {
				values.forEach((v) => v.split(" ").forEach((w) => expanded.add(w)))
			}
		}
	}

	// Tenant taxonomy comes from the tenant's own indexed documents.
	const departments: string[] = db
		.all(`SELECT DISTINCT department FROM documents WHERE tenant_id = ?`, tenantId)
		.map((r) => r.department)
	const categories: string[] = db
		.all(`SELECT DISTINCT category FROM documents WHERE tenant_id = ?`, tenantId)
		.map((r) => r.category)

	const matches = (label: string) => {
		const words = tokenize(label)
		return words.length > 0 && words.some((w) => w.length > 3 && expanded.has(w))
	}

	const amounts = [...normalized.matchAll(/(?:₹|rs\.?|inr|\$|usd|€)\s?([\d,]+(?:\.\d+)?)/gi)]
		.map((m) => Number(m[1].replace(/,/g, "")))
		.filter((n) => Number.isFinite(n))
	const machineIds = [...normalized.matchAll(/\b([A-Z]{1,3}-\d{2,5})\b/g)].map((m) => m[1])

	const isAction = ACTION_PATTERNS.some((p) => p.test(lower))
	// Conversational turns (hi, thanks, who are you, what can you do, …) are
	// detected by the smalltalk engine and must never reach retrieval.
	const isSmalltalk = detectSmalltalk(normalized) !== null

	// Amount questions almost always need the approval/procurement documents.
	if (amounts.length > 0) ["approval", "threshold", "procurement", "purchase", "matrix", "limit"].forEach((t) => expanded.add(t))

	return {
		normalized,
		terms: [...expanded],
		hintedDepartments: departments.filter(matches),
		hintedCategories: categories.filter(matches),
		intent: isAction ? "action.incident" : isSmalltalk ? "smalltalk" : "knowledge",
		amounts,
		machineIds,
	}
}
// hist: 2026-09-21T16:58:04+05:30
