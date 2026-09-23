/**
 * Phase 8 - governed enterprise actions.
 *
 * These tests are the specification of the governance, not a smoke test of the
 * three actions. In order, they prove:
 *
 *   - the registry is exactly the three shipped actions, fully described;
 *   - input validation is strict (unknown fields REJECTED, bounds enforced);
 *   - authorization is server-side, per tenant, and denials are audited;
 *   - confirmation is explicit, and consent is not inferred from absence;
 *   - authorization is taken AGAIN after confirmation, so a revoked grant
 *     stops a proposal that is already open;
 *   - the payload cannot change between review and execution;
 *   - tenant isolation holds even with a valid id from another workspace;
 *   - ACTION_MODE=azure never silently falls back to the local mock;
 *   - the audit row carries source document + version attribution.
 *
 * Phase 7 (proactive/streaming orchestration) is DEFERRED, so nothing here
 * exercises an agent-initiated action: every action is proposed and confirmed
 * by an authenticated principal.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { freshDb, makeWorkspace, services, ingestText, type Actor, type Database } from "./helpers.ts"
import { buildAccessScope, decideActionAccess } from "../backend/src/authorization/policy.ts"
import { getConfig, resetConfigCache, ConfigError } from "../backend/src/config/index.ts"
import {
	ACTION_REGISTRY,
	AzureFunctionExecutor,
	GovernedActionError,
	GovernedActionService,
	LocalMockExecutor,
	createActionExecutor,
	findActionDefinition,
	requireActionDefinition,
	validateActionInput,
	type ActionExecutor,
} from "../backend/src/actions/governed/index.ts"
import { grantActionPermission, revokeActionPermission } from "../backend/src/tenants/service.ts"
import { listActivity } from "../backend/src/observability/logger.ts"

/* -------------------------------- fixtures -------------------------------- */

const IT_PERMISSION = "actions.it.create_request"
const APPROVAL_PERMISSION = "actions.approval.submit_request"
const HR_PERMISSION = "actions.hr.create_onboarding_checklist"

const IT_INPUT = {
	subject: "Laptop will not boot",
	description: "The laptop powers on but halts at the vendor logo. Two hard resets have already been attempted.",
	category: "hardware",
	urgency: "high",
}

const APPROVAL_INPUT = {
	title: "Replacement CNC spindle",
	requestType: "purchase",
	amount: 750000,
	currency: "INR",
	justification: "The spindle failed the vibration tolerance check during the quarterly maintenance audit.",
}

const ONBOARDING_INPUT = {
	employeeName: "Asha Rao",
	employeeEmail: "Asha.Rao@Example.com",
	startDate: "2026-01-12",
	department: "Engineering",
	template: "engineering",
	needsLaptop: true,
}

type Fixture = {
	db: Database
	tenantId: string
	employee: Actor
	itStaff: Actor
	admin: Actor
	service: GovernedActionService
}

function workspace(executor: ActionExecutor = new LocalMockExecutor()): Fixture {
	const db = freshDb()
	const { tenant, actor } = makeWorkspace(db, {
		name: "Northwind Manufacturing",
		users: [
			{ name: "Ravi Employee", email: "ravi@northwind.test", roleKey: "EMPLOYEE", department: "Operations" },
			{ name: "Ida Support", email: "ida@northwind.test", roleKey: "IT_SUPPORT", department: "Engineering" },
			{ name: "Ada Admin", email: "ada@northwind.test", roleKey: "ADMIN", department: "Management" },
		],
		roles: [
			{ key: "EMPLOYEE", name: "Employee", grants: [{ department: "*", maxClassification: "internal" }] },
			{ key: "IT_SUPPORT", name: "IT Support", grants: [{ department: "*", maxClassification: "confidential" }] },
			{
				key: "ADMIN",
				name: "Administrator",
				isAdmin: true,
				canUploadKnowledge: true,
				grants: [{ department: "*", maxClassification: "restricted" }],
			},
		],
	})
	// Only IT_SUPPORT is granted the IT action. EMPLOYEE is granted nothing.
	grantActionPermission(db, { tenantId: tenant.id, roleKey: "IT_SUPPORT", actionPermission: IT_PERMISSION })
	return {
		db,
		tenantId: tenant.id,
		employee: actor("ravi@northwind.test"),
		itStaff: actor("ida@northwind.test"),
		admin: actor("ada@northwind.test"),
		service: new GovernedActionService(db, executor),
	}
}

function actorOf(fixture: Fixture, who: Actor) {
	return {
		userId: who.user.id,
		name: who.user.name,
		email: who.user.email,
		roleKey: who.user.roleKey,
		department: who.user.department,
	}
}

/** Scope rebuilt from the database, as requireIdentity() does on every request. */
function freshScope(fixture: Fixture, who: Actor) {
	return buildAccessScope(fixture.db, who.principal)
}

/* -------------------------------- registry -------------------------------- */

test("the registry ships exactly three actions with unique ids and permissions", () => {
	assert.equal(ACTION_REGISTRY.length, 3)
	assert.deepEqual(
		ACTION_REGISTRY.map((definition) => definition.id),
		["create_it_request", "submit_approval_request", "create_onboarding_checklist"],
	)
	assert.equal(new Set(ACTION_REGISTRY.map((d) => d.id)).size, 3)
	assert.equal(new Set(ACTION_REGISTRY.map((d) => d.requiredPermission)).size, 3)
	assert.equal(new Set(ACTION_REGISTRY.map((d) => d.functionRoute)).size, 3)
})

test("every action definition is fully described and requires confirmation", () => {
	for (const definition of ACTION_REGISTRY) {
		assert.ok(definition.name.length > 3, `${definition.id} needs a name`)
		assert.ok(definition.description.length > 40, `${definition.id} needs a real description`)
		assert.match(definition.requiredPermission, /^actions\.[a-z]+\.[a-z_]+$/)
		assert.equal(definition.confirmationRequired, true, `${definition.id} writes, so it must be confirmed`)
		assert.ok(definition.input.length > 0)
		assert.ok(definition.output.length > 0)
		assert.ok(definition.input.some((field) => field.required))
	}
})

test("an unknown action id is invalid_action, and never a silent no-op", () => {
	assert.equal(findActionDefinition("delete_everything"), null)
	assert.throws(
		() => requireActionDefinition("delete_everything"),
		(error: unknown) => {
			assert.ok(error instanceof GovernedActionError)
			assert.equal((error as GovernedActionError).code, "invalid_action")
			assert.equal((error as GovernedActionError).statusCode, 404)
			return true
		},
	)
})

/* ------------------------------- validation ------------------------------- */

test("an undeclared input field is rejected rather than stripped", () => {
	const definition = requireActionDefinition("create_it_request")
	assert.throws(
		() => validateActionInput(definition, { ...IT_INPUT, tenantId: "ten_other", isAdmin: true }),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "invalid_input")
			assert.ok((error as GovernedActionError).fields.tenantId)
			assert.ok((error as GovernedActionError).fields.isAdmin)
			return true
		},
	)
})

test("a missing required field is reported per field", () => {
	const definition = requireActionDefinition("create_it_request")
	assert.throws(
		() => validateActionInput(definition, { ...IT_INPUT, subject: "   " }),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "invalid_input")
			assert.match((error as GovernedActionError).fields.subject, /required/i)
			return true
		},
	)
})

test("length, range and enum bounds are all enforced", () => {
	const it = requireActionDefinition("create_it_request")
	const approval = requireActionDefinition("submit_approval_request")
	assert.throws(() => validateActionInput(it, { ...IT_INPUT, subject: "x".repeat(400) }), GovernedActionError)
	assert.throws(() => validateActionInput(it, { ...IT_INPUT, urgency: "apocalyptic" }), GovernedActionError)
	assert.throws(() => validateActionInput(approval, { ...APPROVAL_INPUT, amount: 0 }), GovernedActionError)
	assert.throws(() => validateActionInput(approval, { ...APPROVAL_INPUT, amount: 999_999_999 }), GovernedActionError)
	assert.throws(() => validateActionInput(approval, { ...APPROVAL_INPUT, amount: 12.5 }), GovernedActionError)
})

test("valid input is normalised into a fresh object of declared fields only", () => {
	const definition = requireActionDefinition("create_onboarding_checklist")
	const validated = validateActionInput(definition, { ...ONBOARDING_INPUT, needsLaptop: "true" })
	assert.deepEqual(Object.keys(validated).sort(), [
		"department",
		"employeeEmail",
		"employeeName",
		"needsLaptop",
		"startDate",
		"template",
	])
	// Emails are lower-cased; booleans are coerced from their string form.
	assert.equal(validated.employeeEmail, "asha.rao@example.com")
	assert.equal(validated.needsLaptop, true)
})

test("a malformed date or email is refused", () => {
	const definition = requireActionDefinition("create_onboarding_checklist")
	assert.throws(() => validateActionInput(definition, { ...ONBOARDING_INPUT, startDate: "next Monday" }), GovernedActionError)
	assert.throws(() => validateActionInput(definition, { ...ONBOARDING_INPUT, employeeEmail: "asha at example" }), GovernedActionError)
})

/* ------------------------------ authorization ----------------------------- */

test("decideActionAccess refuses a role with no grant and allows one with it", () => {
	const fixture = workspace()
	const it = requireActionDefinition("create_it_request")
	assert.deepEqual(decideActionAccess(freshScope(fixture, fixture.employee), it), {
		allowed: false,
		reason: "action_permission_not_granted",
	})
	assert.deepEqual(decideActionAccess(freshScope(fixture, fixture.itStaff), it), {
		allowed: true,
		reason: "role_action_grant",
	})
})

test("an administrator is allowed without an explicit grant, and is audited as such", () => {
	const fixture = workspace()
	const decision = decideActionAccess(freshScope(fixture, fixture.admin), requireActionDefinition("submit_approval_request"))
	assert.deepEqual(decision, { allowed: true, reason: "admin_role" })
})

test("a grant is scoped to one tenant and does not leak to another workspace", () => {
	const fixture = workspace()
	const other = makeWorkspace(fixture.db, {
		name: "Contoso Freight",
		users: [{ name: "Sam Other", email: "sam@contoso.test", roleKey: "IT_SUPPORT", department: "Engineering" }],
		roles: [{ key: "IT_SUPPORT", name: "IT Support", grants: [{ department: "*", maxClassification: "internal" }] }],
	})
	const scope = buildAccessScope(fixture.db, other.actor("sam@contoso.test").principal)
	// Same role key, different tenant: the grant in Northwind means nothing here.
	assert.deepEqual(scope.actionPermissions, [])
	assert.equal(decideActionAccess(scope, requireActionDefinition("create_it_request")).allowed, false)
})

test("proposing an action without the permission is forbidden and the denial is audited", async () => {
	const fixture = workspace()
	await assert.rejects(
		fixture.service.propose({
			scope: freshScope(fixture, fixture.employee),
			actor: actorOf(fixture, fixture.employee),
			actionId: "create_it_request",
			input: IT_INPUT,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "forbidden")
			assert.equal((error as GovernedActionError).statusCode, 403)
			return true
		},
	)
	const denials = fixture.service.list(freshScope(fixture, fixture.employee))
	assert.equal(denials.length, 1)
	assert.equal(denials[0].status, "failed")
	assert.equal(denials[0].authorization.decision, "denied")
	assert.equal(denials[0].authorization.reason, "action_permission_not_granted")
	// The refused payload is deliberately NOT retained.
	assert.deepEqual(denials[0].input, {})
	assert.ok(listActivity(fixture.db, fixture.tenantId).some((entry) => entry.action === "Action Denied"))
})

test("authorization is checked before input validation, so a denial reveals no schema detail", async () => {
	const fixture = workspace()
	await assert.rejects(
		fixture.service.propose({
			scope: freshScope(fixture, fixture.employee),
			actor: actorOf(fixture, fixture.employee),
			actionId: "create_it_request",
			// Deliberately invalid: an authorized caller would get invalid_input.
			input: { nonsense: true },
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "forbidden")
			return true
		},
	)
})

/* ------------------------------ confirmation ------------------------------ */

test("a proposal is parked in awaiting_confirmation and executes nothing", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	assert.equal(record.status, "awaiting_confirmation")
	assert.equal(record.result, null)
	assert.equal(record.confirmedAt, null)
	assert.equal(record.confirmationRequired, true)
	assert.equal(record.tenantId, fixture.tenantId)
	assert.equal(record.requestedBy.userId, fixture.itStaff.user.id)
})

test("consent must be explicit: a missing confirm flag is confirmation_required", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	for (const confirm of [undefined, null, "true", 1, {}]) {
		await assert.rejects(
			fixture.service.confirm({
				scope: freshScope(fixture, fixture.itStaff),
				actor: actorOf(fixture, fixture.itStaff),
				actionRequestId: record.id,
				confirm,
			}),
			(error: unknown) => {
				assert.equal((error as GovernedActionError).code, "confirmation_required")
				return true
			},
			`confirm=${JSON.stringify(confirm)} must not be treated as consent`,
		)
	}
	assert.equal(fixture.service.get(fixture.tenantId, record.id)?.status, "awaiting_confirmation")
})

test("confirm:false rejects the action and never calls the executor", async () => {
	let calls = 0
	const counting: ActionExecutor = {
		name: "local_mock",
		simulated: true,
		execute: async (definition, input, context) => {
			calls += 1
			return definition.runLocally(input, context)
		},
	}
	const fixture = workspace(counting)
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	const { record: rejected } = await fixture.service.confirm({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionRequestId: record.id,
		confirm: false,
	})
	assert.equal(rejected.status, "rejected")
	assert.equal(rejected.result, null)
	assert.equal(calls, 0)
})

test("confirm:true executes, records the reference and marks the result simulated locally", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	const { record: done } = await fixture.service.confirm({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionRequestId: record.id,
		confirm: true,
	})
	assert.equal(done.status, "succeeded")
	assert.equal(done.executor, "local_mock")
	assert.equal(done.simulated, true)
	assert.ok(done.confirmedAt)
	assert.match(done.result?.reference ?? "", /^ITR-\d{4}-[0-9A-F]{8}$/)
	assert.match(done.result?.summary ?? "", /SIMULATED/)
	assert.equal(done.result?.detail.priority, "P2")
})

test("an action cannot be confirmed twice", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	await fixture.service.confirm({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionRequestId: record.id,
		confirm: true,
	})
	await assert.rejects(
		fixture.service.confirm({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionRequestId: record.id,
			confirm: true,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "confirmation_required")
			assert.match((error as Error).message, /already succeeded/)
			return true
		},
	)
})

test("only the requester may confirm their own pending action", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	// Even an administrator cannot confirm somebody else's write: the audit row
	// would then name the wrong human as the person who agreed to it.
	await assert.rejects(
		fixture.service.confirm({
			scope: freshScope(fixture, fixture.admin),
			actor: actorOf(fixture, fixture.admin),
			actionRequestId: record.id,
			confirm: true,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "forbidden")
			return true
		},
	)
	assert.equal(fixture.service.get(fixture.tenantId, record.id)?.status, "awaiting_confirmation")
})

/* --------------------------- re-authorization ----------------------------- */

test("a grant revoked between propose and confirm stops the action", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	assert.equal(record.status, "awaiting_confirmation")

	// The administrator revokes the capability while the proposal is open.
	revokeActionPermission(fixture.db, {
		tenantId: fixture.tenantId,
		roleKey: "IT_SUPPORT",
		actionPermission: IT_PERMISSION,
	})

	await assert.rejects(
		fixture.service.confirm({
			// Rebuilt from Neon on this request, exactly as requireIdentity() does.
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionRequestId: record.id,
			confirm: true,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "forbidden")
			assert.match((error as Error).message, /withdrawn/i)
			return true
		},
	)
	const stored = fixture.service.get(fixture.tenantId, record.id)
	assert.equal(stored?.status, "failed")
	assert.equal(stored?.authorization.decision, "denied")
	assert.equal(stored?.error?.code, "forbidden")
	assert.equal(stored?.result, null)
})

test("a role change that removes the grant also stops the action", async () => {
	const fixture = workspace()
	grantActionPermission(fixture.db, {
		tenantId: fixture.tenantId,
		roleKey: "IT_SUPPORT",
		actionPermission: APPROVAL_PERMISSION,
	})
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "submit_approval_request",
		input: APPROVAL_INPUT,
	})
	revokeActionPermission(fixture.db, {
		tenantId: fixture.tenantId,
		roleKey: "IT_SUPPORT",
		actionPermission: APPROVAL_PERMISSION,
	})
	await assert.rejects(
		fixture.service.confirm({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionRequestId: record.id,
			confirm: true,
		}),
		GovernedActionError,
	)
})

/* ---------------------------- tenant isolation ---------------------------- */

test("a valid action request id from another tenant is not confirmable", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	const other = makeWorkspace(fixture.db, {
		name: "Contoso Freight",
		users: [{ name: "Sam Other", email: "sam@contoso.test", roleKey: "ADMIN", department: "Management" }],
		roles: [
			{ key: "ADMIN", name: "Administrator", isAdmin: true, grants: [{ department: "*", maxClassification: "restricted" }] },
		],
	})
	const intruder = other.actor("sam@contoso.test")
	await assert.rejects(
		fixture.service.confirm({
			scope: buildAccessScope(fixture.db, intruder.principal),
			actor: {
				userId: intruder.user.id,
				name: intruder.user.name,
				email: intruder.user.email,
				roleKey: intruder.user.roleKey,
				department: intruder.user.department,
			},
			// A real, currently-pending id - from a workspace they are not in.
			actionRequestId: record.id,
			confirm: true,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "tenant_mismatch")
			return true
		},
	)
	assert.equal(fixture.service.get(fixture.tenantId, record.id)?.status, "awaiting_confirmation")
	// The intruder's own list is empty: no cross-tenant read either.
	assert.deepEqual(fixture.service.list(buildAccessScope(fixture.db, intruder.principal), { all: true }), [])
})

test("the tenant is taken from the scope, so a tenantId in the payload cannot redirect it", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		// `tenantId` is not a declared field of the action, so it is rejected
		// outright rather than quietly used. Belt and braces: the service never
		// reads a tenant from the input in the first place.
		input: IT_INPUT,
		conversationId: null,
	})
	assert.equal(record.tenantId, fixture.tenantId)
	await assert.rejects(
		fixture.service.propose({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionId: "create_it_request",
			input: { ...IT_INPUT, tenantId: "ten_somebody_else" },
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "invalid_input")
			return true
		},
	)
})

/* ------------------------- frozen payload + audit ------------------------- */

test("the executed payload is the one frozen at propose time", async () => {
	const seen: Array<Record<string, unknown>> = []
	const recording: ActionExecutor = {
		name: "local_mock",
		simulated: true,
		execute: async (definition, input, context) => {
			seen.push({ ...input })
			return definition.runLocally(input, context)
		},
	}
	const fixture = workspace(recording)
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	// confirm() accepts a decision and nothing else - there is no parameter
	// through which a different subject or amount could be substituted.
	await fixture.service.confirm({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionRequestId: record.id,
		confirm: true,
	})
	assert.equal(seen.length, 1)
	assert.equal(seen[0].subject, IT_INPUT.subject)
	assert.deepEqual(seen[0], record.input)
})

test("the audit row attributes the action to the source document and version", async () => {
	const fixture = workspace()
	const svc = services(fixture.db)
	const ingested = await ingestText(svc, {
		tenantId: fixture.tenantId,
		filename: "it-support-policy.txt",
		text: "IT support policy. Hardware faults are raised with the service desk within one working day.",
		uploadedBy: fixture.admin.user.id,
		department: "Engineering",
		classification: "internal",
		version: "v3",
	})
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
		sourceDocumentId: ingested.document.id,
		sourceVersionId: ingested.version.id,
	})
	assert.equal(record.source.documentId, ingested.document.id)
	assert.equal(record.source.versionId, ingested.version.id)
	assert.equal(record.source.versionLabel, "v3")
	assert.ok(record.source.documentTitle)
	// The attribution survives execution, so the receipt cites the same version.
	const { record: done } = await fixture.service.confirm({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionRequestId: record.id,
		confirm: true,
	})
	assert.equal(done.source.versionLabel, "v3")
})

test("an action cannot be attributed to a document the requester may not read", async () => {
	const fixture = workspace()
	const svc = services(fixture.db)
	const restricted = await ingestText(svc, {
		tenantId: fixture.tenantId,
		filename: "board-pack.txt",
		text: "Restricted board material concerning the proposed plant closure and associated redundancies.",
		uploadedBy: fixture.admin.user.id,
		department: "Management",
		classification: "restricted",
	})
	await assert.rejects(
		fixture.service.propose({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionId: "create_it_request",
			input: IT_INPUT,
			sourceDocumentId: restricted.document.id,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "forbidden")
			return true
		},
	)
})

test("every state transition is mirrored into the shared activity audit feed", async () => {
	const fixture = workspace()
	const { record } = await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	await fixture.service.confirm({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionRequestId: record.id,
		confirm: true,
	})
	const actions = listActivity(fixture.db, fixture.tenantId)
		.filter((entry) => entry.resourceType === "action")
		.map((entry) => entry.action)
	for (const expected of ["Action Proposed", "Action Confirmed", "Action Executed"]) {
		assert.ok(actions.includes(expected), `missing audit entry: ${expected}`)
	}
})

test("a principal sees only their own action history unless they are an admin", async () => {
	const fixture = workspace()
	grantActionPermission(fixture.db, {
		tenantId: fixture.tenantId,
		roleKey: "IT_SUPPORT",
		actionPermission: HR_PERMISSION,
	})
	await fixture.service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_onboarding_checklist",
		input: ONBOARDING_INPUT,
	})
	assert.equal(fixture.service.list(freshScope(fixture, fixture.employee)).length, 0)
	assert.equal(fixture.service.list(freshScope(fixture, fixture.itStaff)).length, 1)
	// `all` is honoured only for an administrator.
	assert.equal(fixture.service.list(freshScope(fixture, fixture.employee), { all: true }).length, 0)
	assert.equal(fixture.service.list(freshScope(fixture, fixture.admin), { all: true }).length, 1)
})

/* ------------------------- the three actions locally ---------------------- */

test("all three actions execute end to end under the local mock", async () => {
	const fixture = workspace()
	for (const roleKey of ["IT_SUPPORT"]) {
		for (const permission of [APPROVAL_PERMISSION, HR_PERMISSION]) {
			grantActionPermission(fixture.db, { tenantId: fixture.tenantId, roleKey, actionPermission: permission })
		}
	}
	const cases: Array<[string, Record<string, unknown>, RegExp]> = [
		["create_it_request", IT_INPUT, /^ITR-/],
		["submit_approval_request", APPROVAL_INPUT, /^APR-/],
		["create_onboarding_checklist", ONBOARDING_INPUT, /^ONB-/],
	]
	for (const [actionId, input, referencePattern] of cases) {
		const { record } = await fixture.service.propose({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionId,
			input,
		})
		const { record: done } = await fixture.service.confirm({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionRequestId: record.id,
			confirm: true,
		})
		assert.equal(done.status, "succeeded", `${actionId} did not succeed`)
		assert.match(done.result?.reference ?? "", referencePattern)
		assert.equal(done.simulated, true)
	}
})

test("the approval chain is derived server-side from the amount", async () => {
	const fixture = workspace()
	grantActionPermission(fixture.db, {
		tenantId: fixture.tenantId,
		roleKey: "IT_SUPPORT",
		actionPermission: APPROVAL_PERMISSION,
	})
	const bands: Array<[number, string, number]> = [
		[10_000, "manager", 1],
		[60_000, "director", 2],
		[750_000, "executive", 3],
		[9_000_000, "board", 4],
	]
	for (const [amount, band, approvers] of bands) {
		const { record } = await fixture.service.propose({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionId: "submit_approval_request",
			input: { ...APPROVAL_INPUT, amount },
		})
		const { record: done } = await fixture.service.confirm({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionRequestId: record.id,
			confirm: true,
		})
		assert.equal(done.result?.detail.thresholdBand, band)
		assert.equal(String(done.result?.detail.approvalChain).split(" -> ").length, approvers)
	}
})

test("the catalogue reports per-principal authorization without exposing values", () => {
	const fixture = workspace()
	const employee = fixture.service.catalog(freshScope(fixture, fixture.employee))
	const itStaff = fixture.service.catalog(freshScope(fixture, fixture.itStaff))
	assert.equal(employee.length, 3)
	assert.deepEqual(
		employee.map((entry) => entry.authorized),
		[false, false, false],
	)
	assert.equal(itStaff.find((entry) => entry.id === "create_it_request")?.authorized, true)
	assert.equal(itStaff.find((entry) => entry.id === "submit_approval_request")?.authorized, false)
	// The catalogue is a schema, never data.
	assert.ok(!JSON.stringify(employee).includes("Laptop will not boot"))
})

/* ------------------------------- azure mode ------------------------------- */

const ACTION_ENV_KEYS = ["ACTION_MODE", "DATABASE_URL", "AZURE_ACTION_FUNCTION_URL", "AZURE_ACTION_FUNCTION_KEY"]

function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>): void | Promise<void> {
	const saved = new Map(ACTION_ENV_KEYS.map((key) => [key, process.env[key]]))
	for (const key of ACTION_ENV_KEYS) delete process.env[key]
	for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
	resetConfigCache()
	const restore = () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		resetConfigCache()
	}
	try {
		const result = run()
		if (result instanceof Promise) return result.finally(restore)
		restore()
		return undefined
	} catch (error) {
		restore()
		throw error
	}
}

test("ACTION_MODE=azure without a Function URL refuses to start instead of simulating", () => {
	withEnv({ ACTION_MODE: "azure", DATABASE_URL: "postgresql://user:pw@example.neon.tech/nova" }, () => {
		assert.throws(
			() => getConfig(),
			(error: unknown) => {
				assert.ok(error instanceof ConfigError)
				assert.match((error as Error).message, /AZURE_ACTION_FUNCTION_URL/)
				assert.match((error as Error).message, /no fallback to the local mock/i)
				return true
			},
		)
	})
})

test("ACTION_MODE=azure refuses a non-https Function URL outside localhost", () => {
	withEnv(
		{
			ACTION_MODE: "azure",
			DATABASE_URL: "postgresql://user:pw@example.neon.tech/nova",
			AZURE_ACTION_FUNCTION_URL: "http://nova-actions.azurewebsites.net",
		},
		() => {
			assert.throws(() => getConfig(), ConfigError)
		},
	)
})

test("ACTION_MODE=azure loads the Function executor, and local mode loads the mock", () => {
	withEnv({}, () => {
		assert.equal(createActionExecutor().name, "local_mock")
		assert.equal(createActionExecutor().simulated, true)
	})
	withEnv(
		{
			ACTION_MODE: "azure",
			DATABASE_URL: "postgresql://user:pw@example.neon.tech/nova",
			AZURE_ACTION_FUNCTION_URL: "https://nova-actions.azurewebsites.net",
			AZURE_ACTION_FUNCTION_KEY: "test-only-not-a-real-key",
		},
		() => {
			const executor = createActionExecutor({ fetchImpl: async () => new Response("{}") })
			assert.equal(executor.name, "azure_function")
			assert.equal(executor.simulated, false, "an Azure result must never be labelled simulated")
		},
	)
})

test("the Azure executor posts to the action's own route with the key in a header", async () => {
	const fixture = workspace()
	let capturedUrl = ""
	let capturedHeaders: Record<string, string> = {}
	let capturedBody: any = null
	const executor = new AzureFunctionExecutor({
		baseUrl: "https://nova-actions.azurewebsites.net/",
		functionKey: "test-only-not-a-real-key",
		fetchImpl: async (url, init) => {
			capturedUrl = String(url)
			capturedHeaders = (init?.headers ?? {}) as Record<string, string>
			capturedBody = JSON.parse(String(init?.body))
			return new Response(
				JSON.stringify({ ok: true, reference: "ITR-2026-ABCDEF01", summary: "raised", detail: { priority: "P2" } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			)
		},
	})
	const service = new GovernedActionService(fixture.db, executor)
	const { record } = await service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	const { record: done } = await service.confirm({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionRequestId: record.id,
		confirm: true,
	})
	assert.equal(capturedUrl, "https://nova-actions.azurewebsites.net/api/actions/create-it-request")
	assert.equal(capturedHeaders["x-functions-key"], "test-only-not-a-real-key")
	// The key is never put in the URL, where it would land in every access log.
	assert.doesNotMatch(capturedUrl, /test-only-not-a-real-key/)
	// Identity is server-resolved, not client-supplied.
	assert.equal(capturedBody.tenantId, fixture.tenantId)
	assert.equal(capturedBody.actor.userId, fixture.itStaff.user.id)
	assert.equal(done.status, "succeeded")
	assert.equal(done.simulated, false)
	assert.equal(done.result?.reference, "ITR-2026-ABCDEF01")
	assert.doesNotMatch(done.result?.summary ?? "", /SIMULATED/)
})

test("an unreachable Function app is function_unavailable and the action is recorded failed", async () => {
	const fixture = workspace()
	const executor = new AzureFunctionExecutor({
		baseUrl: "https://nova-actions.azurewebsites.net",
		fetchImpl: async () => {
			throw new Error("getaddrinfo ENOTFOUND nova-actions.azurewebsites.net")
		},
	})
	const service = new GovernedActionService(fixture.db, executor)
	const { record } = await service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	await assert.rejects(
		service.confirm({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionRequestId: record.id,
			confirm: true,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "function_unavailable")
			// The endpoint and the transport message must not reach the caller.
			assert.doesNotMatch((error as Error).message, /ENOTFOUND|azurewebsites/)
			return true
		},
	)
	const stored = service.get(fixture.tenantId, record.id)
	assert.equal(stored?.status, "failed")
	assert.equal(stored?.error?.code, "function_unavailable")
})

test("a Function 5xx is function_error and a Function 4xx is action_failed", async () => {
	for (const [status, expected] of [
		[500, "function_error"],
		[503, "function_error"],
		[401, "function_error"],
		[400, "action_failed"],
		[422, "action_failed"],
	] as Array<[number, string]>) {
		const fixture = workspace()
		const executor = new AzureFunctionExecutor({
			baseUrl: "https://nova-actions.azurewebsites.net",
			fetchImpl: async () =>
				new Response(JSON.stringify({ ok: false, error: { code: "invalid_input", message: "rejected" } }), { status }),
		})
		const service = new GovernedActionService(fixture.db, executor)
		const { record } = await service.propose({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionId: "create_it_request",
			input: IT_INPUT,
		})
		await assert.rejects(
			service.confirm({
				scope: freshScope(fixture, fixture.itStaff),
				actor: actorOf(fixture, fixture.itStaff),
				actionRequestId: record.id,
				confirm: true,
			}),
			(error: unknown) => {
				assert.equal((error as GovernedActionError).code, expected, `HTTP ${status}`)
				return true
			},
		)
		assert.equal(service.get(fixture.tenantId, record.id)?.status, "failed")
	}
})

test("a malformed Function success body is treated as an unknown outcome, not a success", async () => {
	const fixture = workspace()
	const executor = new AzureFunctionExecutor({
		baseUrl: "https://nova-actions.azurewebsites.net",
		fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
	})
	const service = new GovernedActionService(fixture.db, executor)
	const { record } = await service.propose({
		scope: freshScope(fixture, fixture.itStaff),
		actor: actorOf(fixture, fixture.itStaff),
		actionId: "create_it_request",
		input: IT_INPUT,
	})
	await assert.rejects(
		service.confirm({
			scope: freshScope(fixture, fixture.itStaff),
			actor: actorOf(fixture, fixture.itStaff),
			actionRequestId: record.id,
			confirm: true,
		}),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "function_error")
			assert.match((error as Error).message, /unknown/i)
			return true
		},
	)
})

test("constructing the Azure executor without an endpoint is refused", () => {
	assert.throws(
		() => new AzureFunctionExecutor({ baseUrl: "" }),
		(error: unknown) => {
			assert.equal((error as GovernedActionError).code, "function_unavailable")
			return true
		},
	)
})

test("no action error message ever leaks a stack trace, path or credential", async () => {
	const fixture = workspace()
	const errors: string[] = []
	for (const attempt of [
		() =>
			fixture.service.propose({
				scope: freshScope(fixture, fixture.employee),
				actor: actorOf(fixture, fixture.employee),
				actionId: "create_it_request",
				input: IT_INPUT,
			}),
		() =>
			fixture.service.propose({
				scope: freshScope(fixture, fixture.itStaff),
				actor: actorOf(fixture, fixture.itStaff),
				actionId: "create_it_request",
				input: { subject: "hi" },
			}),
		() =>
			fixture.service.propose({
				scope: freshScope(fixture, fixture.itStaff),
				actor: actorOf(fixture, fixture.itStaff),
				actionId: "not_a_real_action",
				input: {},
			}),
	]) {
		await attempt().catch((error: Error) => errors.push(error.message))
	}
	assert.equal(errors.length, 3)
	for (const message of errors) {
		assert.doesNotMatch(message, /at .*\(.*:\d+:\d+\)/)
		assert.doesNotMatch(message, /\/(home|data|usr|var)\//)
		assert.doesNotMatch(message, /postgres(ql)?:\/\//)
	}
})
