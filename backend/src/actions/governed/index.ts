/**
 * Phase 8 public surface for governed enterprise actions.
 *
 * Phase 7 (proactive / streaming agent orchestration) is DEFERRED; this module
 * is entered only from an authenticated human request.
 */
import type { Database } from "../../db/index.ts"
import { GovernedActionService } from "./service.ts"
import { createActionExecutor } from "./executors.ts"

export function createGovernedActionService(
	db: Database,
	options: { fetchImpl?: typeof fetch } = {},
): GovernedActionService {
	return new GovernedActionService(db, createActionExecutor(options))
}

export { GovernedActionService } from "./service.ts"
export { AzureFunctionExecutor, LocalMockExecutor, createActionExecutor } from "./executors.ts"
export {
	ACTION_PERMISSIONS,
	ACTION_REGISTRY,
	findActionDefinition,
	listActionDefinitions,
	requireActionDefinition,
} from "./registry.ts"
export { validateActionInput } from "./schema.ts"
export {
	ACTION_ERROR_CODES,
	ACTION_STATUSES,
	GovernedActionError,
	TERMINAL_ACTION_STATUSES,
} from "./types.ts"
export type {
	ActionDefinition,
	ActionErrorCode,
	ActionExecutionContext,
	ActionExecutionResult,
	ActionExecutor,
	ActionField,
	ActionInput,
	ActionRequestRecord,
	ActionSourceAttribution,
	ActionStatus,
} from "./types.ts"
