/**
 * Phase 8 - governed enterprise actions: the shared vocabulary.
 *
 * An "action" here is a WRITE into an enterprise system of record. Reading a
 * policy is reversible and cheap; raising a ticket, requesting an approval or
 * provisioning an onboarding checklist is neither. So every action in NOVA is
 * described by DATA (an ActionDefinition in a registry) rather than by a
 * hand-written endpoint, and the same governed pipeline runs for all of them:
 *
 *   validate input -> authorize -> require human confirmation ->
 *   RE-authorize -> execute -> audit
 *
 * Nothing in this file imports the database, HTTP layer or Azure. The registry
 * is a pure description so it can be tested, listed and reasoned about without
 * standing anything up.
 *
 * NOTE ON PHASE 7: proactive/streaming agent orchestration is DEFERRED. No
 * type here assumes an agent decided to run an action; the caller is always an
 * authenticated human principal and the confirmation step is always a human's.
 */

/* ------------------------------ state model ------------------------------ */

/**
 * The action state machine. Every transition is persisted, including refusals,
 * so the audit table answers "what was attempted" and not merely "what ran".
 *
 *   proposed              a request was accepted for consideration
 *   awaiting_confirmation validated + authorized, waiting for a human to confirm
 *   authorized            confirmed and RE-authorized; cleared to execute
 *   rejected              the human declined; the executor was never called
 *   executing             handed to the executor (local mock or Azure Function)
 *   succeeded             the system of record accepted it
 *   failed                validation, re-authorization or execution refused it
 *
 * `authorized` and `executing` are deliberately distinct: a row stuck in
 * `executing` is the evidence that NOVA handed work downstream and never heard
 * back, which is a materially different operational situation from a refusal.
 */
export const ACTION_STATUSES = [
	"proposed",
	"awaiting_confirmation",
	"authorized",
	"rejected",
	"executing",
	"succeeded",
	"failed",
] as const

export type ActionStatus = (typeof ACTION_STATUSES)[number]

/** Statuses from which nothing further may happen. */
export const TERMINAL_ACTION_STATUSES: readonly ActionStatus[] = ["rejected", "succeeded", "failed"]

/* --------------------------- structured failures -------------------------- */

/**
 * The complete, closed set of action error codes. These are part of the API
 * contract: clients switch on them, so they are a fixed vocabulary and never
 * carry provider text.
 *
 *   invalid_action       no such action id in the registry
 *   invalid_input        the payload failed the action's input schema
 *   unauthorized         no authenticated principal
 *   forbidden            authenticated, but the role lacks the action permission
 *   confirmation_required a write action was asked to run without a confirmation
 *   tenant_mismatch      the request does not belong to the caller's tenant
 *   function_unavailable ACTION_MODE=azure but the Function app cannot be reached
 *   function_error       the Function app answered with a failure
 *   action_failed        the executor ran and refused the action on its merits
 *   database_error       the audit record could not be written or read
 */
export const ACTION_ERROR_CODES = [
	"invalid_action",
	"invalid_input",
	"unauthorized",
	"forbidden",
	"confirmation_required",
	"tenant_mismatch",
	"function_unavailable",
	"function_error",
	"action_failed",
	"database_error",
] as const

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number]

const STATUS_FOR_CODE: Record<ActionErrorCode, number> = {
	invalid_action: 404,
	invalid_input: 400,
	unauthorized: 401,
	forbidden: 403,
	confirmation_required: 409,
	tenant_mismatch: 403,
	function_unavailable: 503,
	function_error: 502,
	action_failed: 422,
	database_error: 500,
}

/**
 * The only error type the governed action pipeline throws.
 *
 * `message` is written to be shown to a person. `fields` carries per-field
 * validation detail for `invalid_input` and nothing else - it never contains
 * upstream response bodies, endpoints, keys or stack traces.
 */
export class GovernedActionError extends Error {
	readonly statusCode: number

	constructor(
		readonly code: ActionErrorCode,
		message: string,
		readonly fields: Record<string, string> = {},
	) {
		super(message)
		this.name = "GovernedActionError"
		this.statusCode = STATUS_FOR_CODE[code]
	}
}

/* ------------------------------ input schema ------------------------------ */

export type ActionFieldType = "string" | "text" | "enum" | "integer" | "date" | "boolean" | "email"

/**
 * A single input field. The schema is deliberately small and declarative
 * rather than a general-purpose validator dependency: NOVA's actions take flat
 * payloads of scalars, and a closed field list is what makes "reject anything
 * I was not asked for" cheap and obviously correct.
 */
export type ActionField = {
	name: string
	label: string
	type: ActionFieldType
	required: boolean
	/** Inclusive length bounds for string/text/email, ignored otherwise. */
	minLength?: number
	maxLength?: number
	/** Inclusive numeric bounds for integer, ignored otherwise. */
	min?: number
	max?: number
	/** The complete allowed value list for `enum`. */
	options?: readonly string[]
	/** Shown in the confirmation UI; never used as a value. */
	help?: string
}

export type ActionInput = Record<string, string | number | boolean>

/* ------------------------------- definitions ------------------------------ */

export type ActionExecutionContext = {
	/** Always the authenticated principal's tenant. Never a client-supplied id. */
	tenantId: string
	requestId: string
	actor: { userId: string; name: string; email: string; roleKey: string; department: string }
	/** The audit row id, so an executor can echo a correlation id downstream. */
	actionRequestId: string
	source: ActionSourceAttribution | null
}

export type ActionSourceAttribution = {
	documentId: string | null
	versionId: string | null
	documentTitle: string | null
	versionLabel: string | null
}

/** What an executor returns. `reference` is the downstream system's own id. */
export type ActionExecutionResult = {
	reference: string
	summary: string
	/** Safe, already-shaped detail for display and audit. No raw upstream body. */
	detail: Record<string, string | number | boolean>
}

export type ActionExecutorName = "local_mock" | "azure_function"

/**
 * The executor seam. `local_mock` writes nothing to a real system and marks
 * every result simulated; `azure_function` calls the NOVA Actions Function app.
 * There is no third option and no fallback between them.
 */
export interface ActionExecutor {
	readonly name: ActionExecutorName
	/** True only for the local mock. Surfaced to the UI as SIMULATED ACTION. */
	readonly simulated: boolean
	execute(
		definition: ActionDefinition,
		input: ActionInput,
		context: ActionExecutionContext,
	): Promise<ActionExecutionResult>
}

/**
 * One governed action, described completely as data.
 *
 * `requiredPermission` is the authorization key looked up in
 * role_action_permissions. It is a string, not a boolean column, so adding an
 * action never requires a schema change - and an action whose permission has
 * been granted to nobody is simply unavailable rather than open.
 *
 * `confirmationRequired` is true for all three shipped actions because all
 * three write. It exists as a field rather than as an assumption so a genuinely
 * read-only future action does not have to fake a confirmation.
 */
export type ActionDefinition = {
	id: string
	name: string
	description: string
	requiredPermission: string
	confirmationRequired: boolean
	/** Human-facing category, used only for grouping in the UI. */
	category: "it" | "approval" | "hr"
	input: readonly ActionField[]
	/** Declared shape of ActionExecutionResult.detail, for docs and the UI. */
	output: readonly { name: string; label: string }[]
	/** One-line summary of the pending action, shown in the confirmation prompt. */
	summarize: (input: ActionInput) => string
	/** Local, side-effect-free execution. Used by the local mock executor. */
	runLocally: (input: ActionInput, context: ActionExecutionContext) => ActionExecutionResult
	/** Route segment on the Azure Function app, e.g. "create-it-request". */
	functionRoute: string
}

/* -------------------------------- records -------------------------------- */

export type ActionRequestRecord = {
	id: string
	tenantId: string
	actionId: string
	actionName: string
	status: ActionStatus
	requiredPermission: string
	requestedBy: { userId: string; name: string; email: string; roleKey: string; department: string }
	authorization: { decision: "allowed" | "denied"; reason: string }
	confirmationRequired: boolean
	confirmedAt: string | null
	input: ActionInput
	result: ActionExecutionResult | null
	error: { code: ActionErrorCode; message: string } | null
	executor: ActionExecutorName
	simulated: boolean
	conversationId: string | null
	source: ActionSourceAttribution
	requestId: string | null
	createdAt: string
	updatedAt: string
}
