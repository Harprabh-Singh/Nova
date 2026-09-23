/**
 * NOVA Actions - pure request handlers.
 *
 * WHY THIS FILE HAS NO AZURE IMPORTS
 * ----------------------------------
 * Everything that decides an outcome lives here as plain functions over plain
 * objects: `handle(route, body) -> { status, body }`. `src/index.ts` is the
 * only file that knows about @azure/functions, and it does nothing but adapt
 * an HttpRequest into a call here. That means the entire behaviour of the
 * Function app is unit-testable with `node --test` and no Azure emulator, no
 * storage account and no network - and the same tests can be run from the NOVA
 * repository root.
 *
 * WHY THE PAYLOAD IS RE-VALIDATED HERE
 * ------------------------------------
 * NOVA already validated and authorized the request. This app validates again
 * anyway, because it is an independently addressable HTTPS endpoint: anything
 * holding the function key can call it. It is a SECOND enforcement point, not
 * the first. What it does NOT do is re-derive identity: it trusts the caller
 * (NOVA) for tenantId and actor, because it has no directory of its own. That
 * trust is why the app must never be exposed without a function key, APIM or
 * Entra app-level authentication in front of it.
 */

/* -------------------------------- contracts ------------------------------- */

export type ActionActor = {
	userId: string
	name: string
	email: string
	roleKey: string
	department: string
}

export type ActionRequestPayload = {
	actionId?: unknown
	actionRequestId?: unknown
	tenantId?: unknown
	requestId?: unknown
	actor?: unknown
	source?: unknown
	input?: unknown
}

export type SuccessBody = {
	ok: true
	reference: string
	summary: string
	detail: Record<string, string | number | boolean>
	executedAt: string
}

export type ErrorBody = {
	ok: false
	error: { code: string; message: string; fields?: Record<string, string> }
}

export type HandlerResponse = { status: number; body: SuccessBody | ErrorBody }

export const ACTION_ROUTES = ["create-it-request", "submit-approval", "create-onboarding-checklist"] as const
export type ActionRoute = (typeof ACTION_ROUTES)[number]

/** Route -> the NOVA action id it implements. Kept explicit, not derived. */
export const ROUTE_ACTION_ID: Record<ActionRoute, string> = {
	"create-it-request": "create_it_request",
	"submit-approval": "submit_approval_request",
	"create-onboarding-checklist": "create_onboarding_checklist",
}

/* ------------------------------- validation ------------------------------- */

type FieldType = "string" | "text" | "enum" | "integer" | "date" | "boolean" | "email"

type Field = {
	name: string
	label: string
	type: FieldType
	required: boolean
	minLength?: number
	maxLength?: number
	min?: number
	max?: number
	options?: readonly string[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()
}

export class ActionRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		readonly fields: Record<string, string> = {},
	) {
		super(message)
		this.name = "ActionRequestError"
	}
}

/**
 * Same three rules as NOVA's own validator: unknown fields are REJECTED (not
 * stripped), every declared field is bounded, and the result is a fresh object.
 */
function validate(fields: readonly Field[], raw: unknown): Record<string, string | number | boolean> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ActionRequestError("invalid_input", "input must be an object of fields.", 400)
	}
	const body = raw as Record<string, unknown>
	const errors: Record<string, string> = {}
	const declared = new Set(fields.map((field) => field.name))
	for (const key of Object.keys(body)) {
		if (!declared.has(key)) errors[key] = `"${key}" is not an accepted input field.`
	}

	const output: Record<string, string | number | boolean> = {}
	for (const field of fields) {
		const value = body[field.name]
		const absent = value === undefined || value === null || (typeof value === "string" && clean(value) === "")
		if (absent) {
			if (field.required) errors[field.name] = `${field.label} is required.`
			continue
		}
		switch (field.type) {
			case "boolean": {
				if (typeof value === "boolean") output[field.name] = value
				else if (value === "true") output[field.name] = true
				else if (value === "false") output[field.name] = false
				else errors[field.name] = `${field.label} must be true or false.`
				break
			}
			case "integer": {
				const n = typeof value === "number" ? value : Number(String(value).trim())
				if (!Number.isInteger(n)) errors[field.name] = `${field.label} must be a whole number.`
				else if (field.min !== undefined && n < field.min) errors[field.name] = `${field.label} must be at least ${field.min}.`
				else if (field.max !== undefined && n > field.max) errors[field.name] = `${field.label} must be at most ${field.max}.`
				else output[field.name] = n
				break
			}
			case "enum": {
				const text = clean(String(value))
				if (!field.options || !field.options.includes(text)) {
					errors[field.name] = `${field.label} must be one of: ${(field.options ?? []).join(", ")}.`
				} else output[field.name] = text
				break
			}
			case "date": {
				const text = clean(String(value))
				if ((!ISO_DATE.test(text) && !ISO_DATETIME.test(text)) || Number.isNaN(Date.parse(text))) {
					errors[field.name] = `${field.label} must be an ISO date or timestamp.`
				} else output[field.name] = text
				break
			}
			case "email": {
				const text = clean(String(value)).toLowerCase()
				if (text.length > (field.maxLength ?? 320) || !EMAIL.test(text)) {
					errors[field.name] = `${field.label} must be a valid email address.`
				} else output[field.name] = text
				break
			}
			default: {
				if (typeof value === "object") {
					errors[field.name] = `${field.label} must be text.`
					break
				}
				const text = clean(String(value))
				const min = field.minLength ?? 1
				const max = field.maxLength ?? (field.type === "text" ? 4000 : 200)
				if (text.length < min) errors[field.name] = `${field.label} must be at least ${min} characters.`
				else if (text.length > max) errors[field.name] = `${field.label} must be at most ${max} characters.`
				else output[field.name] = text
			}
		}
	}

	if (Object.keys(errors).length > 0) {
		throw new ActionRequestError("invalid_input", "One or more input fields were rejected.", 400, errors)
	}
	return output
}

/* -------------------------------- envelope -------------------------------- */

export type ValidatedEnvelope = {
	actionId: string
	actionRequestId: string
	tenantId: string
	requestId: string
	actor: ActionActor
	input: Record<string, string | number | boolean>
}

const ID = /^[A-Za-z0-9_:.-]{1,128}$/

function requireEnvelope(route: ActionRoute, payload: ActionRequestPayload, fields: readonly Field[]): ValidatedEnvelope {
	const actionId = String(payload.actionId ?? "")
	if (actionId !== ROUTE_ACTION_ID[route]) {
		// A payload for a different action arriving on this route is a wiring
		// bug or a probe; either way it must not execute.
		throw new ActionRequestError(
			"invalid_action",
			`This route executes ${ROUTE_ACTION_ID[route]}, not "${actionId || "(missing)"}".`,
			400,
		)
	}
	const tenantId = String(payload.tenantId ?? "")
	if (!ID.test(tenantId)) {
		throw new ActionRequestError("tenant_mismatch", "A valid tenantId is required.", 400)
	}
	const allowed = (process.env.NOVA_ACTIONS_ALLOWED_TENANTS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
	// Optional allow-list. Empty means "trust the caller's tenant", which is
	// correct for a single-customer deployment; set it for shared hosting.
	if (allowed.length > 0 && !allowed.includes(tenantId)) {
		throw new ActionRequestError("tenant_mismatch", "This tenant is not served by this action endpoint.", 403)
	}
	const actorRaw = (payload.actor ?? {}) as Record<string, unknown>
	const actor: ActionActor = {
		userId: String(actorRaw.userId ?? ""),
		name: String(actorRaw.name ?? ""),
		email: String(actorRaw.email ?? ""),
		roleKey: String(actorRaw.roleKey ?? ""),
		department: String(actorRaw.department ?? ""),
	}
	if (!ID.test(actor.userId)) {
		throw new ActionRequestError("invalid_input", "A valid actor.userId is required.", 400, {
			"actor.userId": "Required.",
		})
	}
	const actionRequestId = String(payload.actionRequestId ?? "")
	if (!ID.test(actionRequestId)) {
		throw new ActionRequestError("invalid_input", "A valid actionRequestId is required.", 400, {
			actionRequestId: "Required.",
		})
	}
	return {
		actionId,
		actionRequestId,
		tenantId,
		requestId: String(payload.requestId ?? actionRequestId),
		actor,
		input: validate(fields, payload.input),
	}
}

/** Reference derived from NOVA's audit row id, so the two systems agree. */
function reference(prefix: string, actionRequestId: string): string {
	const tail = actionRequestId.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase().padStart(8, "0")
	return `${prefix}-${new Date().getUTCFullYear()}-${tail}`
}

/* --------------------------------- actions -------------------------------- */

const IT_FIELDS: readonly Field[] = [
	{ name: "subject", label: "Subject", type: "string", required: true, minLength: 6, maxLength: 160 },
	{ name: "description", label: "Description", type: "text", required: true, minLength: 20, maxLength: 4000 },
	{ name: "category", label: "Category", type: "enum", required: true, options: ["hardware", "software", "access", "network", "other"] },
	{ name: "urgency", label: "Urgency", type: "enum", required: true, options: ["low", "normal", "high", "critical"] },
	{ name: "assetTag", label: "Asset tag", type: "string", required: false, minLength: 2, maxLength: 64 },
]

const APPROVAL_FIELDS: readonly Field[] = [
	{ name: "title", label: "Title", type: "string", required: true, minLength: 6, maxLength: 160 },
	{ name: "requestType", label: "Request type", type: "enum", required: true, options: ["purchase", "expense", "travel", "contract", "headcount"] },
	{ name: "amount", label: "Amount", type: "integer", required: true, min: 1, max: 100_000_000 },
	{ name: "currency", label: "Currency", type: "enum", required: true, options: ["INR", "USD", "EUR", "GBP"] },
	{ name: "justification", label: "Justification", type: "text", required: true, minLength: 20, maxLength: 4000 },
	{ name: "neededBy", label: "Needed by", type: "date", required: false },
]

const ONBOARDING_FIELDS: readonly Field[] = [
	{ name: "employeeName", label: "New hire name", type: "string", required: true, minLength: 2, maxLength: 160 },
	{ name: "employeeEmail", label: "New hire email", type: "email", required: true, maxLength: 320 },
	{ name: "startDate", label: "Start date", type: "date", required: true },
	{ name: "department", label: "Department", type: "string", required: true, minLength: 2, maxLength: 80 },
	{ name: "template", label: "Checklist template", type: "enum", required: true, options: ["engineering", "operations", "finance", "sales", "general"] },
	{ name: "needsLaptop", label: "Needs a laptop", type: "boolean", required: false },
]

export const ROUTE_FIELDS: Record<ActionRoute, readonly Field[]> = {
	"create-it-request": IT_FIELDS,
	"submit-approval": APPROVAL_FIELDS,
	"create-onboarding-checklist": ONBOARDING_FIELDS,
}

function createItRequest(envelope: ValidatedEnvelope): SuccessBody {
	const urgency = String(envelope.input.urgency)
	const priority = urgency === "critical" ? "P1" : urgency === "high" ? "P2" : urgency === "normal" ? "P3" : "P4"
	const slaHours = { P1: 2, P2: 8, P3: 24, P4: 72 }[priority] ?? 72
	const ticketNumber = reference("ITR", envelope.actionRequestId)
	return {
		ok: true,
		reference: ticketNumber,
		summary: `IT ticket ${ticketNumber} raised for ${envelope.actor.name || envelope.actor.userId} (${priority}, ${slaHours}h response).`,
		detail: {
			ticketNumber,
			queue: `it-${envelope.input.category}`,
			priority,
			slaHours,
			subject: String(envelope.input.subject),
			assetTag: envelope.input.assetTag === undefined ? "" : String(envelope.input.assetTag),
		},
		executedAt: new Date().toISOString(),
	}
}

function submitApproval(envelope: ValidatedEnvelope): SuccessBody {
	const amount = Number(envelope.input.amount)
	// Thresholds are evaluated HERE, server-side. The caller never proposes an
	// approval chain, so a requester cannot shorten their own.
	const band = amount >= 5_000_000 ? "board" : amount >= 500_000 ? "executive" : amount >= 50_000 ? "director" : "manager"
	const chains: Record<string, string[]> = {
		manager: ["line_manager"],
		director: ["line_manager", "department_director"],
		executive: ["line_manager", "department_director", "finance_controller"],
		board: ["line_manager", "department_director", "finance_controller", "board_committee"],
	}
	const chain = chains[band]!
	const approvalId = reference("APR", envelope.actionRequestId)
	return {
		ok: true,
		reference: approvalId,
		summary: `Approval ${approvalId} submitted to ${chain.length} approver(s), starting with ${chain[0]}.`,
		detail: {
			approvalId,
			approvalChain: chain.join(" -> "),
			stage: chain[0]!,
			thresholdBand: band,
			amount,
			currency: String(envelope.input.currency),
		},
		executedAt: new Date().toISOString(),
	}
}

function createOnboardingChecklist(envelope: ValidatedEnvelope): SuccessBody {
	const base = ["Issue building access", "Create directory account", "Assign buddy", "Schedule induction"]
	const extra: Record<string, string[]> = {
		engineering: ["Provision source control access", "Provision CI access"],
		operations: ["Issue site PPE", "Book plant safety briefing"],
		finance: ["Provision ledger access"],
		sales: ["Provision CRM access"],
		general: [],
	}
	const tasks = [...base, ...(extra[String(envelope.input.template)] ?? [])]
	if (envelope.input.needsLaptop === true) tasks.push("Order and image laptop")
	const checklistId = reference("ONB", envelope.actionRequestId)
	const due = new Date(Date.parse(String(envelope.input.startDate)) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
	return {
		ok: true,
		reference: checklistId,
		summary: `Onboarding checklist ${checklistId} created with ${tasks.length} tasks for ${envelope.input.employeeName}.`,
		detail: {
			checklistId,
			taskCount: tasks.length,
			owners: ["it", "facilities", String(envelope.input.department).toLowerCase()].join(", "),
			firstTaskDue: due,
			template: String(envelope.input.template),
			requestedBy: envelope.actor.email,
		},
		executedAt: new Date().toISOString(),
	}
}

const IMPLEMENTATIONS: Record<ActionRoute, (envelope: ValidatedEnvelope) => SuccessBody> = {
	"create-it-request": createItRequest,
	"submit-approval": submitApproval,
	"create-onboarding-checklist": createOnboardingChecklist,
}

/* --------------------------------- handler -------------------------------- */

/**
 * The single entry point. Errors are converted to the structured envelope the
 * NOVA backend expects, and never carry a stack trace or an internal path.
 */
export function handle(route: ActionRoute, payload: unknown): HandlerResponse {
	try {
		const envelope = requireEnvelope(route, (payload ?? {}) as ActionRequestPayload, ROUTE_FIELDS[route])
		return { status: 200, body: IMPLEMENTATIONS[route](envelope) }
	} catch (error) {
		if (error instanceof ActionRequestError) {
			return {
				status: error.status,
				body: {
					ok: false,
					error: {
						code: error.code,
						message: error.message,
						...(Object.keys(error.fields).length > 0 ? { fields: error.fields } : {}),
					},
				},
			}
		}
		return {
			status: 500,
			body: { ok: false, error: { code: "action_failed", message: "The action could not be executed." } },
		}
	}
}
