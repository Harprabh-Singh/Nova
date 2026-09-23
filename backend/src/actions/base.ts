/** ActionProvider: enterprise workflow execution seam. */
import type { IncidentSummary } from "../models/types.ts"

export type IncidentInput = {
	tenantId: string
	machineId: string
	description: string
	severity: "low" | "medium" | "high" | "critical"
	location: string
	observedAt: string
	reporter: string
	reporterUserId: string
	conversationId?: string
}

export type ActionResult = {
	simulated: boolean
	provider: string
	incident: IncidentSummary
}

export class ActionError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message)
		this.name = "ActionError"
	}
}

export interface ActionProvider {
	readonly name: string
	readonly mode: "local" | "azure"
	/** True when the result is a simulation rather than a real system of record. */
	readonly simulated: boolean
	createIncident(input: IncidentInput): Promise<ActionResult>
	listIncidents(tenantId: string, limit?: number): Promise<IncidentSummary[]>
	healthCheck(): Promise<{ ok: boolean; detail: string }>
}

export const INCIDENT_FIELDS = [
	"machine_id",
	"description",
	"severity",
	"location",
	"observed_at",
	"reporter",
] as const

export type IncidentField = (typeof INCIDENT_FIELDS)[number]
