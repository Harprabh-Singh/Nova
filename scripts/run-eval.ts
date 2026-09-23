/**
 * NOVA evaluation harness.
 *
 * Runs tests/eval/questions.json through the real in-process RAG pipeline
 * (same services the HTTP API uses) and scores grounding, citations,
 * authorization, versioning, tenant isolation and workflow routing.
 *
 *   npm run eval            all categories
 *   npm run eval -- authz   only categories matching "authz"/name substring
 */
import fs from "node:fs"
import path from "node:path"

import { loadEnv } from "../backend/src/config/index.ts"
import { getDb } from "../backend/src/db/index.ts"
import { createServices } from "../backend/src/api/server.ts"
import { buildAccessScope } from "../backend/src/authorization/policy.ts"
import { getTenant, getUser } from "../backend/src/tenants/service.ts"
import { extractIncidentFields } from "../backend/src/agents/incidentAgent.ts"
import type { Principal } from "../backend/src/models/types.ts"

loadEnv()

type EvalCase = {
	id: string
	category: string
	persona: string
	question: string
	expectGrounded?: boolean
	expectInsufficient?: boolean
	expectAccessDenied?: boolean
	expectCitationFrom?: string
	forbidCitationFrom?: string
	expectVersion?: string
	expectAny?: string[]
	forbidAny?: string[]
	minCitations?: number
	expectWorkflow?: string
}

const cases: EvalCase[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/eval/questions.json"), "utf8"))
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"))[0]
const selected = filter ? cases.filter((c) => c.id.includes(filter) || c.category.includes(filter)) : cases

const db = getDb()
const services = createServices(db)

function principalFor(email: string): Principal {
	const row = db.get(`SELECT * FROM users WHERE email = ?`, email)
	if (!row) throw new Error(`Unknown demo persona ${email}. Run: npm run seed-demo`)
	return {
		tenantId: row.tenant_id,
		userId: row.id,
		name: row.name,
		email: row.email,
		roleKey: row.role_key,
		department: row.department,
		title: row.title,
		authMode: "demo",
	}
}

type Outcome = { id: string; category: string; pass: boolean; failures: string[] }

async function runCase(testCase: EvalCase): Promise<Outcome> {
	const principal = principalFor(testCase.persona)
	const tenant = getTenant(db, principal.tenantId)!
	const user = getUser(db, principal.tenantId, principal.userId)!
	const scope = buildAccessScope(db, principal)
	const failures: string[] = []

	if (testCase.expectWorkflow) {
		// Workflow routing uses the same heuristic the chat endpoint applies.
		const draft = extractIncidentFields(testCase.question, user)
		const looksLikeIncident = /\b(incident|malfunction|report it|breakdown|failure|raise a?n? (ticket|incident))\b/i.test(
			testCase.question,
		)
		if (!looksLikeIncident) failures.push("question was not routed to the incident workflow")
		const turn = await services.incidentAgent.handle({
			tenant,
			user,
			scope,
			message: testCase.question,
			draft,
			conversationId: `eval_${testCase.id}`,
		})
		if (!turn.answer.trim()) failures.push("workflow produced no response")
		if (turn.action && !turn.action.simulated) failures.push("action was not labelled as simulated")
		return { id: testCase.id, category: testCase.category, pass: failures.length === 0, failures }
	}

	const result = await services.knowledgeAgent.answer({
		tenant,
		user,
		scope,
		question: testCase.question,
		requestId: `eval_${testCase.id}`,
	})
	const answer = result.answer.toLowerCase()

	if (testCase.expectAccessDenied === true && !result.security.accessDenied) {
		failures.push("expected ACCESS DENIED")
	}
	if (testCase.expectAccessDenied === false && result.security.accessDenied) {
		failures.push("unexpected ACCESS DENIED for an authorized persona")
	}
	if (testCase.expectGrounded && result.grounding !== "grounded") {
		failures.push(`expected a grounded answer, got ${result.grounding}`)
	}
	if (testCase.expectInsufficient && result.grounding === "grounded") {
		failures.push("expected insufficient evidence, but the answer claimed grounding")
	}
	if (testCase.minCitations && result.citations.length < testCase.minCitations) {
		failures.push(`expected >= ${testCase.minCitations} citations, got ${result.citations.length}`)
	}
	if (testCase.expectCitationFrom && !result.citations.some((c) => c.documentTitle.includes(testCase.expectCitationFrom!))) {
		failures.push(`expected a citation from "${testCase.expectCitationFrom}"`)
	}
	if (testCase.forbidCitationFrom && result.citations.some((c) => c.documentTitle.includes(testCase.forbidCitationFrom!))) {
		failures.push(`cross-tenant leak: cited "${testCase.forbidCitationFrom}"`)
	}
	if (testCase.expectVersion && !result.citations.some((c) => c.version === testCase.expectVersion)) {
		failures.push(`expected the active version ${testCase.expectVersion} to be cited`)
	}
	if (testCase.expectAny && !testCase.expectAny.some((needle) => answer.includes(needle.toLowerCase()))) {
		failures.push(`answer did not mention any of: ${testCase.expectAny.join(" | ")}`)
	}
	if (testCase.forbidAny) {
		for (const needle of testCase.forbidAny) {
			if (answer.includes(needle.toLowerCase())) failures.push(`answer leaked forbidden text: ${needle}`)
		}
	}
	if (result.security.fabricatedCitationMarkers.length > 0) {
		failures.push("model referenced citation markers that were not retrieved")
	}

	return { id: testCase.id, category: testCase.category, pass: failures.length === 0, failures }
}

const outcomes: Outcome[] = []
for (const testCase of selected) {
	try {
		outcomes.push(await runCase(testCase))
	} catch (error) {
		outcomes.push({
			id: testCase.id,
			category: testCase.category,
			pass: false,
			failures: [`threw: ${(error as Error).message}`],
		})
	}
}

const byCategory = new Map<string, { pass: number; total: number }>()
for (const outcome of outcomes) {
	const bucket = byCategory.get(outcome.category) ?? { pass: 0, total: 0 }
	bucket.total += 1
	if (outcome.pass) bucket.pass += 1
	byCategory.set(outcome.category, bucket)
}

console.log("\nNOVA evaluation\n===============")
for (const outcome of outcomes) {
	console.log(`${outcome.pass ? "PASS" : "FAIL"}  ${outcome.id.padEnd(12)} ${outcome.category}`)
	for (const failure of outcome.failures) console.log(`        - ${failure}`)
}
console.log("\nBy category")
for (const [category, bucket] of byCategory) {
	console.log(`  ${category.padEnd(26)} ${bucket.pass}/${bucket.total}`)
}
const passed = outcomes.filter((o) => o.pass).length
console.log(`\nTotal ${passed}/${outcomes.length} passed\n`)

if (passed !== outcomes.length) process.exitCode = 1
