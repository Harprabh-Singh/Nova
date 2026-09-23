/**
 * Unit tests for the NOVA Actions Function app.
 *
 * These run against the PURE handlers, so they need no Functions host, no
 * storage emulator and no network. Run them here with `npm test`, or from the
 * NOVA repository root, where tests/azureFunctionHandlers.test.ts imports the
 * same module so the root suite covers this app too.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ACTION_ROUTES, ROUTE_ACTION_ID, handle } from "../src/handlers.ts"

const ACTOR = {
	userId: "usr_1",
	name: "Georgie Tucker",
	email: "georgie@example.com",
	roleKey: "IT_SUPPORT",
	department: "Engineering",
}

function envelope(route: keyof typeof ROUTE_ACTION_ID, input: Record<string, unknown>) {
	return {
		actionId: ROUTE_ACTION_ID[route],
		actionRequestId: "areq_0123456789abcdef",
		tenantId: "ten_1",
		requestId: "req_abc",
		actor: ACTOR,
		input,
	}
}

const IT_INPUT = {
	subject: "Laptop will not boot",
	description: "The laptop powers on but stops at the vendor logo. A hard reset has already been tried twice.",
	category: "hardware",
	urgency: "high",
}

const APPROVAL_INPUT = {
	title: "Replacement CNC spindle",
	requestType: "purchase",
	amount: 750000,
	currency: "INR",
	justification: "The existing spindle failed the vibration tolerance check in the quarterly maintenance audit.",
}

const ONBOARDING_INPUT = {
	employeeName: "Asha Rao",
	employeeEmail: "asha.rao@example.com",
	startDate: "2026-01-12",
	department: "Engineering",
	template: "engineering",
	needsLaptop: true,
}

test("all three action routes are registered exactly once", () => {
	assert.deepEqual([...ACTION_ROUTES], ["create-it-request", "submit-approval", "create-onboarding-checklist"])
	assert.equal(new Set(ACTION_ROUTES).size, 3)
})

test("create-it-request returns a ticket with a server-derived priority and SLA", () => {
	const response = handle("create-it-request", envelope("create-it-request", IT_INPUT))
	assert.equal(response.status, 200)
	assert.equal(response.body.ok, true)
	const body = response.body as Extract<typeof response.body, { ok: true }>
	assert.match(body.reference, /^ITR-\d{4}-[0-9A-F]{8}$/)
	assert.equal(body.detail.priority, "P2")
	assert.equal(body.detail.slaHours, 8)
	assert.equal(body.detail.queue, "it-hardware")
})

test("submit-approval derives the approval chain from the amount, not from the caller", () => {
	const response = handle("submit-approval", envelope("submit-approval", APPROVAL_INPUT))
	const body = response.body as Extract<typeof response.body, { ok: true }>
	assert.equal(response.status, 200)
	assert.equal(body.detail.thresholdBand, "executive")
	assert.equal(body.detail.approvalChain, "line_manager -> department_director -> finance_controller")
	assert.equal(body.detail.stage, "line_manager")
})

test("submit-approval escalates to the board above the top threshold", () => {
	const response = handle("submit-approval", envelope("submit-approval", { ...APPROVAL_INPUT, amount: 9_000_000 }))
	const body = response.body as Extract<typeof response.body, { ok: true }>
	assert.equal(body.detail.thresholdBand, "board")
	assert.equal(body.detail.approvalChain.toString().split(" -> ").length, 4)
})

test("create-onboarding-checklist builds template tasks and a due date before the start date", () => {
	const response = handle("create-onboarding-checklist", envelope("create-onboarding-checklist", ONBOARDING_INPUT))
	const body = response.body as Extract<typeof response.body, { ok: true }>
	assert.equal(response.status, 200)
	// 4 base + 2 engineering + laptop
	assert.equal(body.detail.taskCount, 7)
	assert.equal(body.detail.firstTaskDue, "2026-01-11")
})

test("an unknown input field is rejected, not silently dropped", () => {
	const response = handle("create-it-request", envelope("create-it-request", { ...IT_INPUT, isAdmin: true }))
	assert.equal(response.status, 400)
	const body = response.body as Extract<typeof response.body, { ok: false }>
	assert.equal(body.error.code, "invalid_input")
	assert.ok(body.error.fields?.isAdmin)
})

test("a missing required field is reported per field", () => {
	const response = handle("create-it-request", envelope("create-it-request", { ...IT_INPUT, subject: "" }))
	assert.equal(response.status, 400)
	const body = response.body as Extract<typeof response.body, { ok: false }>
	assert.equal(body.error.code, "invalid_input")
	assert.match(String(body.error.fields?.subject), /required/i)
})

test("a value outside the declared enum is rejected", () => {
	const response = handle("create-it-request", envelope("create-it-request", { ...IT_INPUT, urgency: "apocalyptic" }))
	assert.equal(response.status, 400)
	assert.equal((response.body as Extract<typeof response.body, { ok: false }>).error.code, "invalid_input")
})

test("an amount above the declared ceiling is rejected", () => {
	const response = handle("submit-approval", envelope("submit-approval", { ...APPROVAL_INPUT, amount: 999_999_999 }))
	assert.equal(response.status, 400)
	assert.equal((response.body as Extract<typeof response.body, { ok: false }>).error.code, "invalid_input")
})

test("a payload for a different action is refused on this route", () => {
	const payload = { ...envelope("create-it-request", IT_INPUT), actionId: "submit_approval_request" }
	const response = handle("create-it-request", payload)
	assert.equal(response.status, 400)
	assert.equal((response.body as Extract<typeof response.body, { ok: false }>).error.code, "invalid_action")
})

test("a missing tenantId is refused with tenant_mismatch", () => {
	const payload = { ...envelope("create-it-request", IT_INPUT), tenantId: "" }
	const response = handle("create-it-request", payload)
	assert.equal(response.status, 400)
	assert.equal((response.body as Extract<typeof response.body, { ok: false }>).error.code, "tenant_mismatch")
})

test("the optional tenant allow-list refuses a tenant it does not serve", () => {
	const previous = process.env.NOVA_ACTIONS_ALLOWED_TENANTS
	process.env.NOVA_ACTIONS_ALLOWED_TENANTS = "ten_other"
	try {
		const response = handle("create-it-request", envelope("create-it-request", IT_INPUT))
		assert.equal(response.status, 403)
		assert.equal((response.body as Extract<typeof response.body, { ok: false }>).error.code, "tenant_mismatch")
	} finally {
		if (previous === undefined) delete process.env.NOVA_ACTIONS_ALLOWED_TENANTS
		else process.env.NOVA_ACTIONS_ALLOWED_TENANTS = previous
	}
})

test("a missing actor identity is refused", () => {
	const payload = { ...envelope("create-it-request", IT_INPUT), actor: {} }
	const response = handle("create-it-request", payload)
	assert.equal(response.status, 400)
	assert.equal((response.body as Extract<typeof response.body, { ok: false }>).error.code, "invalid_input")
})

test("a non-object input body is refused", () => {
	const payload = { ...envelope("create-it-request", IT_INPUT), input: "subject=hello" }
	const response = handle("create-it-request", payload)
	assert.equal(response.status, 400)
	assert.equal((response.body as Extract<typeof response.body, { ok: false }>).error.code, "invalid_input")
})

test("no error response ever contains a stack trace or file path", () => {
	const response = handle("create-it-request", { actionId: "create_it_request" })
	const serialised = JSON.stringify(response.body)
	assert.doesNotMatch(serialised, /at .*\(.*:\d+:\d+\)/)
	assert.doesNotMatch(serialised, /\/(home|data|usr|var)\//)
})
