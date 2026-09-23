import type { ActionProvider } from "./base.ts"
import { LocalActionProvider } from "./local.ts"
import { AzureActionProvider } from "./azure.ts"
import type { Database } from "../db/index.ts"
import { getConfig } from "../config/index.ts"

export function createActionProvider(db: Database): ActionProvider {
	const config = getConfig()
	if (config.modes.actionMode === "azure") {
		return new AzureActionProvider({
			workflowEndpoint: config.azure?.action.workflowUrl ?? "",
			bearerToken: undefined,
			apiKey: config.azure?.action.apiKey,
		})
	}
	return new LocalActionProvider(db)
}

export type { ActionProvider, ActionResult, IncidentInput } from "./base.ts"
export { ActionError, INCIDENT_FIELDS } from "./base.ts"
