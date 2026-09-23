/**
 * LocalActionProvider: writes simulated incidents to the local database.
 * Every result is explicitly marked simulated so the UI can label it
 * SIMULATED ACTION - mock behaviour is never presented as a real integration.
 */
import { randomUUID } from "node:crypto"
import type { ActionProvider, ActionResult, IncidentInput } from "./base.ts"
import { ActionError } from "./base.ts"
import type { Database } from "../db/index.ts"
import type { IncidentSummary } from "../models/types.ts"

function rowToIncident(r: any): IncidentSummary {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		code: r.code,
		machineId: r.machine_id,
		description: r.description,
		severity: r.severity,
		location: r.location,
		observedAt: r.observed_at,
		reporter: r.reporter,
		status: r.status,
		simulated: Boolean(r.simulated),
		createdAt: r.created_at,
	}
}

export class LocalActionProvider implements ActionProvider {
	readonly name = "LocalActionProvider"
	readonly mode = "local" as const
	readonly simulated = true

	constructor(private readonly db: Database) {}

	private nextCode(tenantId: string): string {
		const year = new Date().getFullYear()
		const row = this.db.get(
			`SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND code LIKE ?`,
			tenantId,
			`INC-${year}-%`,
		)
		const sequence = Number(row?.n ?? 0) + 1
		return `INC-${year}-${String(sequence).padStart(4, "0")}`
	}

	async createIncident(input: IncidentInput): Promise<ActionResult> {
		const missing = (
			[
				["machine_id", input.machineId],
				["description", input.description],
				["severity", input.severity],
				["location", input.location],
				["observed_at", input.observedAt],
				["reporter", input.reporter],
			] as Array<[string, string]>
		)
			.filter(([, value]) => !value || !String(value).trim())
			.map(([key]) => key)
		if (missing.length > 0) throw new ActionError(`Missing required fields: ${missing.join(", ")}`)

		const id = `inc_${randomUUID()}`
		const code = this.nextCode(input.tenantId)
		const now = new Date().toISOString()
		this.db.run(
			`INSERT INTO incidents (id, tenant_id, code, machine_id, description, severity, location, observed_at,
				reporter, reporter_user_id, conversation_id, status, simulated, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?)`,
			id,
			input.tenantId,
			code,
			input.machineId,
			input.description,
			input.severity,
			input.location,
			input.observedAt,
			input.reporter,
			input.reporterUserId,
			input.conversationId ?? null,
			now,
		)
		const incident = rowToIncident(this.db.get(`SELECT * FROM incidents WHERE id = ? AND tenant_id = ?`, id, input.tenantId))
		return { simulated: true, provider: this.name, incident }
	}

	async listIncidents(tenantId: string, limit = 50): Promise<IncidentSummary[]> {
		return this.db
			.all(`SELECT * FROM incidents WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`, tenantId, limit)
			.map(rowToIncident)
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		return { ok: true, detail: "Local simulated action provider ready (no external system of record)" }
	}
}
