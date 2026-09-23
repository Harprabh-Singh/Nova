/**
 * AzureActionProvider - DISABLED unless ACTION_MODE=azure.
 *
 * Enterprise actions in a real deployment are executed by a downstream system
 * of record (ServiceNow, Dynamics 365 Field Service, SAP PM, a Logic App, or an
 * Azure Function). Rather than inventing an SDK surface, this adapter posts the
 * incident payload to a configured HTTPS workflow endpoint (Logic App / Function
 * / API Management route) using a bearer token or function key, which is the
 * documented, stable integration contract.
 *
 * Results from this provider are NOT simulated; it must never be enabled while
 * the endpoint is unconfigured.
 */
import { randomUUID } from "node:crypto"
import type { ActionProvider, ActionResult, IncidentInput } from "./base.ts"
import { ActionError } from "./base.ts"
import type { IncidentSummary } from "../models/types.ts"

export type AzureActionProviderOptions = {
	workflowEndpoint: string
	bearerToken?: string
	apiKey?: string
	timeoutMs?: number
}

export class AzureActionProvider implements ActionProvider {
	readonly name = "AzureActionProvider"
	readonly mode = "azure" as const
	readonly simulated = false

	constructor(private readonly options: AzureActionProviderOptions) {
		if (!options.workflowEndpoint) {
			throw new Error("ACTION_MODE=azure requires AZURE_ACTION_WORKFLOW_URL")
		}
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json" }
		if (this.options.bearerToken) headers["authorization"] = `Bearer ${this.options.bearerToken}`
		if (this.options.apiKey) headers["x-functions-key"] = this.options.apiKey
		return headers
	}

	async createIncident(input: IncidentInput): Promise<ActionResult> {
		const response = await fetch(this.options.workflowEndpoint, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({
				tenantId: input.tenantId,
				machineId: input.machineId,
				description: input.description,
				severity: input.severity,
				location: input.location,
				observedAt: input.observedAt,
				reporter: input.reporter,
			}),
			signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
		})
		if (!response.ok) throw new ActionError(`Workflow endpoint returned HTTP ${response.status}`, 502)
		const payload = (await response.json()) as { code?: string; id?: string; status?: string }
		const incident: IncidentSummary = {
			id: payload.id ?? `inc_${randomUUID()}`,
			tenantId: input.tenantId,
			code: payload.code ?? "UNKNOWN",
			machineId: input.machineId,
			description: input.description,
			severity: input.severity,
			location: input.location,
			observedAt: input.observedAt,
			reporter: input.reporter,
			status: (payload.status as IncidentSummary["status"]) ?? "open",
			simulated: false,
			createdAt: new Date().toISOString(),
		}
		return { simulated: false, provider: this.name, incident }
	}

	async listIncidents(): Promise<IncidentSummary[]> {
		throw new ActionError("Incident listing is owned by the downstream system of record in Azure mode.", 501)
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		try {
			const response = await fetch(this.options.workflowEndpoint, {
				method: "OPTIONS",
				headers: this.headers(),
				signal: AbortSignal.timeout(5000),
			})
			return { ok: response.ok, detail: `Workflow endpoint HTTP ${response.status}` }
		} catch (error) {
			return { ok: false, detail: `Workflow endpoint unreachable: ${(error as Error).message}` }
		}
	}
}
