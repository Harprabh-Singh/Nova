/**
 * IncidentAgent - the agentic workflow.
 *
 * It grounds the procedure in the tenant's own SOP (retrieved through the same
 * authorized KnowledgeProvider), collects the required fields across turns,
 * asks for what is missing, and then executes the action through ActionProvider.
 */
import type { Database } from "../db/index.ts"
import type { KnowledgeProvider } from "../knowledge/base.ts"
import type { ActionProvider } from "../actions/base.ts"
import { ActionError, INCIDENT_FIELDS } from "../actions/base.ts"
import type { AccessScope } from "../authorization/policy.ts"
import type { ActionRecord, Citation, Tenant, User } from "../models/types.ts"
import { buildCitations } from "../citations/index.ts"
import { understandQuery } from "./queryUnderstanding.ts"

export type IncidentDraft = {
	machine_id?: string
	description?: string
	severity?: string
	location?: string
	observed_at?: string
	reporter?: string
}

export type IncidentTurnResult = {
	answer: string
	citations: Citation[]
	draft: IncidentDraft
	missing: string[]
	action: ActionRecord | null
	complete: boolean
}

const SEVERITIES = ["low", "medium", "high", "critical"]
const FIELD_LABELS: Record<string, string> = {
	machine_id: "Machine / asset ID",
	description: "What happened",
	severity: "Severity (low, medium, high, critical)",
	location: "Location (line, bay, area or site)",
	observed_at: "When it was observed (date and time)",
	reporter: "Reporter",
}

/** Pulls field values out of free text, including "field: value" pairs. */
export function extractIncidentFields(text: string, user: User): IncidentDraft {
	const draft: IncidentDraft = {}
	for (const field of INCIDENT_FIELDS) {
		const pattern = new RegExp(`${field.replace("_", "[ _]?")}\\s*[:=]\\s*([^\\n,;]+)`, "i")
		const match = pattern.exec(text)
		if (match) (draft as Record<string, string>)[field] = match[1].trim()
	}

	const machine = /\b([A-Z]{1,3}-\d{2,5})\b/.exec(text)
	if (!draft.machine_id && machine) draft.machine_id = machine[1]

	const severity = SEVERITIES.find((s) => new RegExp(`\\b${s}\\b`, "i").test(text))
	if (!draft.severity && severity) draft.severity = severity
	if (!draft.severity && /\b(fire|injur|smoke|burn|shock|critical stop)\w*/i.test(text)) draft.severity = "critical"

	const location = /\b(?:at|in|on)\s+((?:line|bay|cell|shop|floor|unit|area|plant|zone|building)\s*[A-Za-z0-9-]{0,12})/i.exec(text)
	if (!draft.location && location) draft.location = location[1].trim()

	if (!draft.observed_at) {
		const iso = /\b(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\b/.exec(text)
		if (iso) draft.observed_at = iso[1]
		else if (/\b(just now|right now|now)\b/i.test(text)) draft.observed_at = new Date().toISOString()
	}

	if (!draft.reporter) {
		const mine = /\b(?:i am|i'm|this is)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/.exec(text)
		draft.reporter = mine?.[1] ?? user.name
	}

	if (!draft.description) {
		const sentence = text
			.split(/(?<=[.!?])\s+/)
			.find((s) => /\b(malfunction|fail|broke|down|stopped|error|fault|leak|jam|overheat|alarm)\w*/i.test(s))
		if (sentence) draft.description = sentence.trim()
	}
	return draft
}

export class IncidentAgent {
	constructor(
		private readonly db: Database,
		private readonly knowledge: KnowledgeProvider,
		private readonly actions: ActionProvider,
	) {}

	async handle(params: {
		tenant: Tenant
		user: User
		scope: AccessScope
		message: string
		draft: IncidentDraft
		conversationId: string
	}): Promise<IncidentTurnResult> {
		const { tenant, user, scope, message } = params

		if (!scope.canCreateIncidents) {
			return {
				answer:
					"ACCESS DENIED\n\nYour current role does not have permission to create incident records in this workspace.",
				citations: [],
				draft: params.draft,
				missing: [],
				action: null,
				complete: false,
			}
		}

		// 1. Ground the procedure in the tenant's own authorized SOP.
		const understanding = understandQuery(this.db, tenant.id, `${message} incident reporting procedure escalation`)
		const retrieval = await this.knowledge.retrieve({
			question: `${message} incident reporting and machine failure procedure`,
			terms: understanding.terms,
			hintedDepartments: understanding.hintedDepartments,
			scope,
			topK: 4,
		})
		const citations = buildCitations(retrieval.chunks)

		// 2. Merge previously collected fields with anything in this message.
		const draft: IncidentDraft = { ...params.draft, ...prune(extractIncidentFields(message, user)) }
		if (draft.severity && !SEVERITIES.includes(draft.severity.toLowerCase())) {
			draft.severity = /crit|fire|injur/i.test(draft.severity)
				? "critical"
				: /high|major/i.test(draft.severity)
					? "high"
					: /low|minor/i.test(draft.severity)
						? "low"
						: "medium"
		}

		const missing = INCIDENT_FIELDS.filter((f) => !String((draft as Record<string, string>)[f] ?? "").trim())

		const procedure = retrieval.chunks.length
			? [
					"Here is the reporting procedure from your authorized knowledge base:",
					...retrieval.chunks.slice(0, 2).map((chunk, i) => {
						const lines = chunk.text
							.split(/\n/)
							.map((l) => l.trim())
							.filter((l) => l.length > 30)
							.slice(0, 4)
						return `${lines.map((l) => `- ${l}`).join("\n")} [${i + 1}]`
					}),
				].join("\n")
			: `I couldn't verify a documented reporting procedure from the available ${tenant.name} knowledge, so I'll capture the standard incident fields.`

		// 3. Ask for missing fields before executing anything.
		if (missing.length > 0) {
			const collected = INCIDENT_FIELDS.filter((f) => !missing.includes(f)).map(
				(f) => `- ${FIELD_LABELS[f]}: ${(draft as Record<string, string>)[f]}`,
			)
			return {
				answer: [
					procedure,
					"",
					collected.length ? `I have recorded:\n${collected.join("\n")}` : "",
					`To file the report I still need:\n${missing.map((f) => `- ${FIELD_LABELS[f]}`).join("\n")}`,
					"",
					"Reply with those details and I will create the incident record.",
				]
					.filter(Boolean)
					.join("\n"),
				citations,
				draft,
				missing,
				action: null,
				complete: false,
			}
		}

		// 4. Execute through the action provider.
		try {
			const result = await this.actions.createIncident({
				tenantId: tenant.id,
				machineId: draft.machine_id!,
				description: draft.description!,
				severity: draft.severity as "low" | "medium" | "high" | "critical",
				location: draft.location!,
				observedAt: draft.observed_at!,
				reporter: draft.reporter!,
				reporterUserId: user.id,
				conversationId: params.conversationId,
			})
			const action: ActionRecord = {
				kind: "incident",
				simulated: result.simulated,
				provider: result.provider,
				incident: result.incident,
			}
			return {
				answer: [
					procedure,
					"",
					`${result.simulated ? "SIMULATED ACTION - " : ""}Incident ${result.incident.code} has been created.`,
					`- Machine: ${result.incident.machineId}`,
					`- Severity: ${result.incident.severity}`,
					`- Location: ${result.incident.location}`,
					`- Observed at: ${result.incident.observedAt}`,
					`- Reported by: ${result.incident.reporter}`,
					result.simulated
						? "\nThis record was created in NOVA's local simulation, not in a real maintenance system."
						: "",
				]
					.filter(Boolean)
					.join("\n"),
				citations,
				draft: {},
				missing: [],
				action,
				complete: true,
			}
		} catch (error) {
			const detail = error instanceof ActionError ? error.message : "The incident could not be created."
			return {
				answer: `I could not complete the incident report: ${detail}`,
				citations,
				draft,
				missing: [],
				action: null,
				complete: false,
			}
		}
	}
}

function prune(draft: IncidentDraft): IncidentDraft {
	const output: Record<string, string> = {}
	for (const [key, value] of Object.entries(draft)) {
		if (value && String(value).trim()) output[key] = String(value).trim()
	}
	return output as IncidentDraft
}
// hist: 2026-09-22T21:15:59+05:30
