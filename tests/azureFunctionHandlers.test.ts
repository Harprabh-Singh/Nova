/**
 * The NOVA Actions Azure Function app, covered by the ROOT test suite.
 *
 * azure-functions/nova-actions is a separate npm package with its own
 * `npm test`, but a Function app that is only tested in its own folder is a
 * Function app nobody runs the tests for. Its handlers are deliberately pure
 * (no @azure/functions import), so the same module can be exercised here and
 * `npm test` at the repository root proves both halves of the Phase 8
 * execution path in one command.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ACTION_ROUTES, ROUTE_ACTION_ID, ROUTE_FIELDS, handle } from "../azure-functions/nova-actions/src/handlers.ts"
import { ACTION_REGISTRY } from "../backend/src/actions/governed/index.ts"

const BASE = {
	actionRequestId: "areq_0123456789abcdef",
	tenantId: "ten_northwind",
	requestId: "req_abc123",
	actor: {
		userId: "usr_ida",
		name: "Ida Support",
		email: "ida@northwind.test",
		roleKey: "IT_SUPPORT",
		department: "Engineering",
	},
}

const IT_INPUT = {
	subject: "Laptop will not boot",
	description: "The laptop powers on but halts at the vendor logo. Two hard resets have already been attempted.",
	category: "hardware",
	urgency: "high",
}

test("the Function app implements exactly the routes the NOVA registry declares", () => {
	assert.deepEqual([...ACTION_ROUTES].sort(), ACTION_REGISTRY.map((d) => d.functionRoute).sort())
	for (const definition of ACTION_REGISTRY) {
		assert.equal(
			ROUTE_ACTION_ID[definition.functionRoute as keyof typeof ROUTE_ACTION_ID],
			definition.id,
			`${definition.functionRoute} must execute ${definition.id}`,
		)
	}
})

test("the Function app's field schema matches the NOVA registry field for field", () => {
	for (const definition of ACTION_REGISTRY) {
		const functionFields = ROUTE_FIELDS[definition.functionRoute as keyof typeof ROUTE_FIELDS]
		assert.deepEqual(
			functionFields.map((field) => `${field.name}:${field.type}:${field.required}`),
			definition.input.map((field) => `${field.name}:${field.type}:${field.required}`),
			`schema drift on ${definition.id}: the second enforcement point must not be weaker than the first`,
		)
	}
})

test("a well-formed IT request is executed and returns a reference", () => {
	const response = handle("create-it-request", { ...BASE, actionId: "create_it_request", input: IT_INPUT })
	assert.equal(response.status, 200)
	assert.equal(response.body.ok, true)
})

test("the Function app rejects an undeclared field even though NOVA already validated", () => {
	const response = handle("create-it-request", {
		...BASE,
		actionId: "create_it_request",
		input: { ...IT_INPUT, escalateToBoard: true },
	})
	assert.equal(response.status, 400)
	assert.equal(response.body.ok, false)
})

test("the Function app refuses a payload whose actionId does not match the route", () => {
	const response = handle("submit-approval", { ...BASE, actionId: "create_it_request", input: IT_INPUT })
	assert.equal(response.status, 400)
	assert.equal((response.body as { error: { code: string } }).error.code, "invalid_action")
})

test("the Function app refuses a request with no tenant", () => {
	const response = handle("create-it-request", {
		...BASE,
		tenantId: "",
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	assert.equal((response.body as { error: { code: string } }).error.code, "tenant_mismatch")
})
