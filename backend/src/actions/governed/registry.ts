/**
 * The governed action registry.
 *
 * WHY A REGISTRY AND NOT THREE ENDPOINTS
 * --------------------------------------
 * Every action needs exactly the same guarantees: strict input validation,
 * server-side authorization, tenant isolation, explicit human confirmation,
 * re-authorization after that confirmation, and an audit row. Writing three
 * endpoints means writing those guarantees three times, and the fourth action
 * is the one where somebody forgets the re-check. So the guarantees live once
 * in the service, and an action contributes only its DESCRIPTION: its
 * permission key, its input schema, its summary line and its local behaviour.
 *
 * Adding an action is a registry entry, a permission grant and a Function
 * route - it is not new authorization code.
 *
 * THREE ACTIONS SHIP. No more, by design: each one is a real enterprise write
 * with a distinct permission, so the authorization model is exercised rather
 * than demonstrated once.
 */
import { GovernedActionError } from "./types.ts"
import type { ActionDefinition, ActionExecutionContext, ActionInput } from "./types.ts"

/** Deterministic, human-quotable reference derived from the audit row id. */
function reference(prefix: string, actionRequestId: string): string {
	const tail = actionRequestId.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase().padStart(8, "0")
	return `${prefix}-${new Date().getUTCFullYear()}-${tail}`
}

const IT_CATEGORIES = ["hardware", "software", "access", "network", "other"] as const
const IT_URGENCIES = ["low", "normal", "high", "critical"] as const
const APPROVAL_TYPES = ["purchase", "expense", "travel", "contract", "headcount"] as const
const ONBOARDING_TEMPLATES = ["engineering", "operations", "finance", "sales", "general"] as const

/* --------------------------- create_it_request --------------------------- */

const createItRequest: ActionDefinition = {
	id: "create_it_request",
	name: "Create IT support request",
	description:
		"Raises a ticket with the IT service desk. Use when a person needs hardware, software, access or network help that a policy answer alone cannot resolve.",
	requiredPermission: "actions.it.create_request",
	confirmationRequired: true,
	category: "it",
	functionRoute: "create-it-request",
	input: [
		{ name: "subject", label: "Subject", type: "string", required: true, minLength: 6, maxLength: 160 },
		{
			name: "description",
			label: "Description",
			type: "text",
			required: true,
			minLength: 20,
			maxLength: 4000,
			help: "What is broken or needed, and what has already been tried.",
		},
		{ name: "category", label: "Category", type: "enum", required: true, options: IT_CATEGORIES },
		{ name: "urgency", label: "Urgency", type: "enum", required: true, options: IT_URGENCIES },
		{
			name: "assetTag",
			label: "Asset tag",
			type: "string",
			required: false,
			minLength: 2,
			maxLength: 64,
			help: "Optional. The affected device's asset tag, if there is one.",
		},
	],
	output: [
		{ name: "ticketNumber", label: "Ticket number" },
		{ name: "queue", label: "Queue" },
		{ name: "priority", label: "Priority" },
		{ name: "slaHours", label: "Response SLA (hours)" },
	],
	summarize: (input) => `Open an IT ticket: "${input.subject}" (${input.category}, ${input.urgency} urgency).`,
	runLocally: (input, context) => {
		const urgency = String(input.urgency)
		const priority = urgency === "critical" ? "P1" : urgency === "high" ? "P2" : urgency === "normal" ? "P3" : "P4"
		const slaHours = { P1: 2, P2: 8, P3: 24, P4: 72 }[priority] ?? 72
		const ticketNumber = reference("ITR", context.actionRequestId)
		return {
			reference: ticketNumber,
			summary: `IT ticket ${ticketNumber} raised for ${context.actor.name} (${priority}, ${slaHours}h response).`,
			detail: {
				ticketNumber,
				queue: `it-${input.category}`,
				priority,
				slaHours,
				subject: String(input.subject),
				assetTag: input.assetTag === undefined ? "" : String(input.assetTag),
			},
		}
	},
}

/* ------------------------- submit_approval_request ------------------------ */

const submitApprovalRequest: ActionDefinition = {
	id: "submit_approval_request",
	name: "Submit approval request",
	description:
		"Routes a spend or commitment for approval. The approval CHAIN is decided by the amount, not by the requester, so a person cannot route their own request to a friendlier approver.",
	requiredPermission: "actions.approval.submit_request",
	confirmationRequired: true,
	category: "approval",
	functionRoute: "submit-approval",
	input: [
		{ name: "title", label: "Title", type: "string", required: true, minLength: 6, maxLength: 160 },
		{ name: "requestType", label: "Request type", type: "enum", required: true, options: APPROVAL_TYPES },
		{
			name: "amount",
			label: "Amount",
			type: "integer",
			required: true,
			min: 1,
			max: 100_000_000,
			help: "Whole units of the workspace currency.",
		},
		{ name: "currency", label: "Currency", type: "enum", required: true, options: ["INR", "USD", "EUR", "GBP"] },
		{
			name: "justification",
			label: "Justification",
			type: "text",
			required: true,
			minLength: 20,
			maxLength: 4000,
			help: "Why this spend is necessary, and the policy clause that permits it.",
		},
		{ name: "neededBy", label: "Needed by", type: "date", required: false },
	],
	output: [
		{ name: "approvalId", label: "Approval id" },
		{ name: "approvalChain", label: "Approval chain" },
		{ name: "stage", label: "Current stage" },
		{ name: "thresholdBand", label: "Threshold band" },
	],
	summarize: (input) =>
		`Submit a ${input.requestType} approval for ${input.currency} ${Number(input.amount).toLocaleString("en-US")}: "${input.title}".`,
	runLocally: (input, context) => {
		const amount = Number(input.amount)
		// Thresholds are a property of the ACTION, evaluated server-side. The
		// client never proposes a chain and cannot shorten one.
		const band = amount >= 5_000_000 ? "board" : amount >= 500_000 ? "executive" : amount >= 50_000 ? "director" : "manager"
		const chains: Record<string, string[]> = {
			manager: ["line_manager"],
			director: ["line_manager", "department_director"],
			executive: ["line_manager", "department_director", "finance_controller"],
			board: ["line_manager", "department_director", "finance_controller", "board_committee"],
		}
		const chain = chains[band] ?? chains.manager
		const approvalId = reference("APR", context.actionRequestId)
		return {
			reference: approvalId,
			summary: `Approval ${approvalId} submitted to ${chain.length} approver(s), starting with ${chain[0]}.`,
			detail: {
				approvalId,
				approvalChain: chain.join(" -> "),
				stage: chain[0],
				thresholdBand: band,
				amount,
				currency: String(input.currency),
			},
		}
	},
}

/* ---------------------- create_onboarding_checklist ---------------------- */

const createOnboardingChecklist: ActionDefinition = {
	id: "create_onboarding_checklist",
	name: "Create onboarding checklist",
	description:
		"Provisions a joining checklist for a new hire. This creates tasks for other teams, so it is restricted to roles that own onboarding rather than to anyone who can read the HR handbook.",
	requiredPermission: "actions.hr.create_onboarding_checklist",
	confirmationRequired: true,
	category: "hr",
	functionRoute: "create-onboarding-checklist",
	input: [
		{ name: "employeeName", label: "New hire name", type: "string", required: true, minLength: 2, maxLength: 160 },
		{ name: "employeeEmail", label: "New hire email", type: "email", required: true, maxLength: 320 },
		{ name: "startDate", label: "Start date", type: "date", required: true },
		{ name: "department", label: "Department", type: "string", required: true, minLength: 2, maxLength: 80 },
		{ name: "template", label: "Checklist template", type: "enum", required: true, options: ONBOARDING_TEMPLATES },
		{ name: "needsLaptop", label: "Needs a laptop", type: "boolean", required: false },
	],
	output: [
		{ name: "checklistId", label: "Checklist id" },
		{ name: "taskCount", label: "Tasks created" },
		{ name: "owners", label: "Task owners" },
		{ name: "firstTaskDue", label: "First task due" },
	],
	summarize: (input) =>
		`Create a ${input.template} onboarding checklist for ${input.employeeName} (${input.department}), starting ${input.startDate}.`,
	runLocally: (input, context) => {
		const base = ["Issue building access", "Create directory account", "Assign buddy", "Schedule induction"]
		const extra: Record<string, string[]> = {
			engineering: ["Provision source control access", "Provision CI access"],
			operations: ["Issue site PPE", "Book plant safety briefing"],
			finance: ["Provision ledger access"],
			sales: ["Provision CRM access"],
			general: [],
		}
		const tasks = [...base, ...(extra[String(input.template)] ?? [])]
		if (input.needsLaptop === true) tasks.push("Order and image laptop")
		const checklistId = reference("ONB", context.actionRequestId)
		// First task is due one working-day-ish before the start date.
		const due = new Date(Date.parse(String(input.startDate)) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
		return {
			reference: checklistId,
			summary: `Onboarding checklist ${checklistId} created with ${tasks.length} tasks for ${input.employeeName}.`,
			detail: {
				checklistId,
				taskCount: tasks.length,
				owners: ["it", "facilities", String(input.department).toLowerCase()].join(", "),
				firstTaskDue: due,
				template: String(input.template),
				requestedBy: context.actor.email,
			},
		}
	},
}

/* -------------------------------- registry ------------------------------- */

export const ACTION_REGISTRY: readonly ActionDefinition[] = Object.freeze([
	createItRequest,
	submitApprovalRequest,
	createOnboardingChecklist,
])

/** Every permission key the shipped registry can possibly require. */
export const ACTION_PERMISSIONS: readonly string[] = Object.freeze(
	ACTION_REGISTRY.map((definition) => definition.requiredPermission),
)

export function listActionDefinitions(): readonly ActionDefinition[] {
	return ACTION_REGISTRY
}

export function findActionDefinition(actionId: unknown): ActionDefinition | null {
	const id = String(actionId ?? "")
	return ACTION_REGISTRY.find((definition) => definition.id === id) ?? null
}

/**
 * Registry lookup that refuses rather than returns null. `invalid_action` is a
 * 404 and says nothing about what actions DO exist beyond the public catalogue.
 */
export function requireActionDefinition(actionId: unknown): ActionDefinition {
	const definition = findActionDefinition(actionId)
	if (!definition) {
		throw new GovernedActionError("invalid_action", `"${String(actionId ?? "")}" is not a NOVA action.`)
	}
	return definition
}

export type { ActionDefinition, ActionExecutionContext, ActionInput }
