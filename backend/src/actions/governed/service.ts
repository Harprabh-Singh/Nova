/**
 * GovernedActionService - the one place the governance rules live.
 *
 * THE PIPELINE (identical for every action in the registry)
 * ---------------------------------------------------------
 *   propose():
 *     1. resolve the action from the registry            -> invalid_action
 *     2. authorize the CALLER'S scope against it         -> forbidden
 *        (audited even when denied - a refused attempt is evidence)
 *     3. validate the input strictly                     -> invalid_input
 *     4. resolve + access-check the source document      -> forbidden
 *     5. write the audit row as awaiting_confirmation
 *
 *   confirm():
 *     6. load the row BY (tenant, id) from the caller's tenant -> tenant_mismatch
 *     7. refuse anything not awaiting confirmation       -> confirmation_required
 *     8. RE-AUTHORIZE against a freshly read scope       -> forbidden
 *     9. RE-VALIDATE the stored input                    -> invalid_input
 *    10. execute, then record succeeded / failed
 *
 * WHY RE-AUTHORIZE AT STEP 8
 * --------------------------
 * The confirmation is a second request, seconds or minutes later, and NOVA is
 * a system where an administrator revokes a grant precisely because they want
 * it to stop working NOW. If authorization were only checked at propose time,
 * a proposal held open across a revocation would still execute - a confirmed
 * action would be running on a permission its requester no longer has. So the
 * decision is taken again, from Neon, on the confirming request, and the audit
 * row keeps whichever decision was made last.
 *
 * WHY THE INPUT IS NOT ACCEPTED AT CONFIRM TIME
 * ---------------------------------------------
 * The confirm endpoint takes no payload beyond the decision. The input it
 * executes is the one frozen at propose time and re-validated from the audit
 * row. Otherwise "confirm" becomes a second, unreviewed write path: a client
 * could show a person a 5,000 purchase, get their yes, and submit 500,000.
 *
 * Phase 7 note: nothing here is triggered by an agent. An action is proposed
 * by an authenticated human request and confirmed by an authenticated human
 * request. Autonomous/proactive orchestration is DEFERRED with Phase 7.
 */
import { randomUUID } from "node:crypto"

import type { Database } from "../../db/index.ts"
import { decideActionAccess, decideDocumentAccess, type AccessScope } from "../../authorization/policy.ts"
import { log, recordActivity } from "../../observability/logger.ts"
import type { Classification } from "../../models/types.ts"
import { GovernedActionError, TERMINAL_ACTION_STATUSES } from "./types.ts"
import type {
	ActionDefinition,
	ActionErrorCode,
	ActionExecutionResult,
	ActionExecutor,
	ActionInput,
	ActionRequestRecord,
	ActionSourceAttribution,
	ActionStatus,
} from "./types.ts"
import { ACTION_REGISTRY, listActionDefinitions, requireActionDefinition } from "./registry.ts"
import { validateActionInput } from "./schema.ts"

export type ActionActor = {
	userId: string
	name: string
	email: string
	roleKey: string
	department: string
}

export type ProposeInput = {
	scope: AccessScope
	actor: ActionActor
	actionId: unknown
	input: unknown
	conversationId?: string | null
	sourceDocumentId?: string | null
	sourceVersionId?: string | null
	requestId?: string | null
}

export type ConfirmInput = {
	scope: AccessScope
	actor: ActionActor
	actionRequestId: string
	/** Must be explicitly true to execute. Absent is NOT consent. */
	confirm: unknown
	requestId?: string | null
}

const EMPTY_SOURCE: ActionSourceAttribution = {
	documentId: null,
	versionId: null,
	documentTitle: null,
	versionLabel: null,
}

/** Any unexpected database failure becomes a single, non-leaking error code. */
function guardDb<T>(operation: () => T): T {
	try {
		return operation()
	} catch (error) {
		if (error instanceof GovernedActionError) throw error
		log.error("action.database_error", { detail: (error as Error).message })
		throw new GovernedActionError(
			"database_error",
			"The action could not be recorded, so it was not performed. Please retry.",
		)
	}
}

function parseJson<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== "string" || raw === "") return fallback
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}

function rowToRecord(row: any): ActionRequestRecord {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		actionId: row.action_id,
		actionName: row.action_name,
		status: row.status as ActionStatus,
		requiredPermission: row.required_permission,
		requestedBy: {
			userId: row.requested_by_user_id,
			name: row.requested_by_name,
			email: row.requested_by_email ?? "",
			roleKey: row.requested_by_role_key,
			department: row.requested_by_department ?? "",
		},
		authorization: {
			decision: row.authorization_decision === "allowed" ? "allowed" : "denied",
			reason: row.authorization_reason,
		},
		confirmationRequired: Boolean(Number(row.confirmation_required)),
		confirmedAt: row.confirmed_at ?? null,
		input: parseJson<ActionInput>(row.input_json, {}),
		result: parseJson<ActionExecutionResult | null>(row.result_json, null),
		error: row.error_code
			? { code: row.error_code as ActionErrorCode, message: row.error_message ?? "" }
			: null,
		executor: row.executor,
		simulated: Boolean(Number(row.simulated)),
		conversationId: row.conversation_id ?? null,
		source: {
			documentId: row.source_document_id ?? null,
			versionId: row.source_version_id ?? null,
			documentTitle: row.source_document_title ?? null,
			versionLabel: row.source_version_label ?? null,
		},
		requestId: row.request_id ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export class GovernedActionService {
	constructor(
		private readonly db: Database,
		private readonly executor: ActionExecutor,
	) {}

	get executorName(): ActionExecutor["name"] {
		return this.executor.name
	}

	get simulated(): boolean {
		return this.executor.simulated
	}

	/**
	 * The action catalogue for a specific principal.
	 *
	 * Every action is listed, with `authorized` telling the client whether this
	 * caller may request it. Hiding unauthorized actions entirely would make the
	 * UI lie about what the product does; listing them does not weaken anything,
	 * because the permission is enforced server-side on propose AND on confirm.
	 * No input VALUES are in this payload - only the declared schema.
	 */
	catalog(scope: AccessScope) {
		return listActionDefinitions().map((definition) => {
			const decision = decideActionAccess(scope, definition)
			return {
				id: definition.id,
				name: definition.name,
				description: definition.description,
				category: definition.category,
				requiredPermission: definition.requiredPermission,
				confirmationRequired: definition.confirmationRequired,
				authorized: decision.allowed,
				authorizationReason: decision.reason,
				input: definition.input,
				output: definition.output,
			}
		})
	}

	/* ------------------------------ propose ------------------------------ */

	async propose(request: ProposeInput): Promise<{ record: ActionRequestRecord; definition: ActionDefinition }> {
		const definition = requireActionDefinition(request.actionId)
		const now = new Date().toISOString()
		const id = `areq_${randomUUID()}`

		// 2. Authorization FIRST, before the input is even looked at: an
		// unauthorized caller must not be able to use validation messages to
		// probe the shape of an action they may not perform.
		const decision = decideActionAccess(request.scope, definition, request.scope.tenantId)
		if (!decision.allowed) {
			this.writeDenial(id, definition, request, decision.reason, now)
			throw new GovernedActionError(
				decision.reason === "tenant_mismatch" ? "tenant_mismatch" : "forbidden",
				decision.reason === "tenant_mismatch"
					? "This action does not belong to your workspace."
					: `Your role is not permitted to use "${definition.name}". Ask an administrator for the "${definition.requiredPermission}" permission.`,
			)
		}

		// 3. Strict input validation.
		const input = validateActionInput(definition, request.input)

		// 4. Source attribution, access-checked. An action may only be attributed
		// to a document this principal can actually read - otherwise the audit
		// trail itself would confirm the existence of restricted material.
		const source = this.resolveSource(request.scope, request.sourceDocumentId, request.sourceVersionId)

		const status: ActionStatus = definition.confirmationRequired ? "awaiting_confirmation" : "authorized"
		const record: ActionRequestRecord = {
			id,
			tenantId: request.scope.tenantId,
			actionId: definition.id,
			actionName: definition.name,
			status,
			requiredPermission: definition.requiredPermission,
			requestedBy: request.actor,
			authorization: { decision: "allowed", reason: decision.reason },
			confirmationRequired: definition.confirmationRequired,
			confirmedAt: null,
			input,
			result: null,
			error: null,
			executor: this.executor.name,
			simulated: this.executor.simulated,
			conversationId: request.conversationId ?? null,
			source,
			requestId: request.requestId ?? null,
			createdAt: now,
			updatedAt: now,
		}
		guardDb(() => this.insert(record))
		this.audit(record, "Action Proposed", "success", `${definition.id} awaiting confirmation`)

		// An action that needs no confirmation (none ship today) executes here.
		if (!definition.confirmationRequired) {
			return { record: await this.run(record, definition), definition }
		}
		return { record, definition }
	}

	/* ------------------------------ confirm ------------------------------ */

	async confirm(request: ConfirmInput): Promise<{ record: ActionRequestRecord; definition: ActionDefinition }> {
		// 6. Scoped read. The tenant comes from the authenticated scope, so a
		// request id from another workspace is simply not found here.
		const record = this.get(request.scope.tenantId, request.actionRequestId)
		if (!record) {
			throw new GovernedActionError(
				"tenant_mismatch",
				"That action request does not exist in your workspace.",
			)
		}
		// Belt and braces: the row was selected by tenant, and is checked again.
		if (record.tenantId !== request.scope.tenantId) {
			throw new GovernedActionError("tenant_mismatch", "That action request does not exist in your workspace.")
		}
		// Only the person who proposed it may confirm it. A colleague - even an
		// administrator - confirming someone else's pending write would make the
		// audit trail name the wrong human.
		if (record.requestedBy.userId !== request.scope.userId) {
			throw new GovernedActionError("forbidden", "Only the person who requested this action can confirm it.")
		}
		if (TERMINAL_ACTION_STATUSES.includes(record.status)) {
			throw new GovernedActionError(
				"confirmation_required",
				`This action was already ${record.status} and cannot be confirmed again.`,
			)
		}
		if (record.status !== "awaiting_confirmation") {
			throw new GovernedActionError(
				"confirmation_required",
				`This action is ${record.status} and is not waiting for a confirmation.`,
			)
		}

		const definition = requireActionDefinition(record.actionId)

		// 7. Consent must be explicit. Undefined, "yes", 1 and {} are not a yes.
		if (request.confirm !== true) {
			if (request.confirm === false) {
				const rejected = guardDb(() =>
					this.update(record.id, record.tenantId, {
						status: "rejected",
						authorization_reason: record.authorization.reason,
					}),
				)
				this.audit(rejected, "Action Rejected", "denied", `${definition.id} declined by requester`)
				return { record: rejected, definition }
			}
			throw new GovernedActionError(
				"confirmation_required",
				`${definition.name} needs an explicit confirmation. Send {"confirm": true} to proceed or {"confirm": false} to discard it.`,
			)
		}

		// 8. RE-AUTHORIZATION. `request.scope` was rebuilt from Neon on THIS
		// request, so a grant revoked since the proposal is honoured now.
		const decision = decideActionAccess(request.scope, definition, record.tenantId)
		if (!decision.allowed) {
			const failed = guardDb(() =>
				this.update(record.id, record.tenantId, {
					status: "failed",
					authorization_decision: "denied",
					authorization_reason: decision.reason,
					error_code: decision.reason === "tenant_mismatch" ? "tenant_mismatch" : "forbidden",
					error_message: "Authorization was withdrawn before the action was confirmed.",
				}),
			)
			this.audit(failed, "Action Denied", "denied", `${definition.id} re-authorization failed: ${decision.reason}`)
			throw new GovernedActionError(
				decision.reason === "tenant_mismatch" ? "tenant_mismatch" : "forbidden",
				"Your permission for this action was withdrawn before you confirmed it, so nothing was submitted.",
			)
		}

		// 9. RE-VALIDATION of the frozen payload. If the registry's schema has
		// tightened since the proposal, the stale proposal fails closed.
		let input: ActionInput
		try {
			input = validateActionInput(definition, record.input)
		} catch (error) {
			const failed = guardDb(() =>
				this.update(record.id, record.tenantId, {
					status: "failed",
					error_code: "invalid_input",
					error_message: error instanceof Error ? error.message.slice(0, 400) : "Invalid input",
				}),
			)
			this.audit(failed, "Action Failed", "error", `${definition.id} stored input no longer valid`)
			throw error
		}

		const authorized = guardDb(() =>
			this.update(record.id, record.tenantId, {
				status: "authorized",
				confirmed_at: new Date().toISOString(),
				authorization_decision: "allowed",
				authorization_reason: decision.reason,
				input_json: JSON.stringify(input),
			}),
		)
		this.audit(authorized, "Action Confirmed", "success", `${definition.id} confirmed by requester`)
		return { record: await this.run(authorized, definition), definition }
	}

	/* ------------------------------- execute ----------------------------- */

	/** 10. Hand to the executor. `executing` is persisted before the call. */
	private async run(record: ActionRequestRecord, definition: ActionDefinition): Promise<ActionRequestRecord> {
		const executing = guardDb(() => this.update(record.id, record.tenantId, { status: "executing" }))
		const startedAt = Date.now()
		try {
			const result = await this.executor.execute(definition, executing.input, {
				tenantId: executing.tenantId,
				requestId: executing.requestId ?? executing.id,
				actor: executing.requestedBy,
				actionRequestId: executing.id,
				source: executing.source.documentId ? executing.source : null,
			})
			const succeeded = guardDb(() =>
				this.update(record.id, record.tenantId, {
					status: "succeeded",
					result_json: JSON.stringify(result),
					executor: this.executor.name,
					simulated: this.executor.simulated ? 1 : 0,
					error_code: null,
					error_message: null,
				}),
			)
			this.audit(
				succeeded,
				"Action Executed",
				"success",
				`${definition.id} -> ${result.reference}${this.executor.simulated ? " (simulated)" : ""}`,
				Date.now() - startedAt,
			)
			return succeeded
		} catch (error) {
			const governed =
				error instanceof GovernedActionError
					? error
					: new GovernedActionError("action_failed", "The action could not be completed. Nothing was submitted.")
			const failed = guardDb(() =>
				this.update(record.id, record.tenantId, {
					status: "failed",
					error_code: governed.code,
					error_message: governed.message.slice(0, 400),
				}),
			)
			this.audit(failed, "Action Failed", "error", `${definition.id} -> ${governed.code}`, Date.now() - startedAt)
			throw governed
		}
	}

	/* -------------------------------- reads ------------------------------ */

	get(tenantId: string, actionRequestId: string): ActionRequestRecord | null {
		const row = guardDb(() =>
			this.db.get(`SELECT * FROM action_requests WHERE id = ? AND tenant_id = ?`, actionRequestId, tenantId),
		)
		return row ? rowToRecord(row) : null
	}

	/**
	 * A principal's own action history, or the whole tenant's for an
	 * administrator. Never cross-tenant: `tenantId` is always the scope's.
	 */
	list(scope: AccessScope, options: { limit?: number; all?: boolean } = {}): ActionRequestRecord[] {
		const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 200)
		const rows = guardDb(() =>
			options.all && scope.isAdmin
				? this.db.all(
						`SELECT * FROM action_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
						scope.tenantId,
						limit,
					)
				: this.db.all(
						`SELECT * FROM action_requests WHERE tenant_id = ? AND requested_by_user_id = ? ORDER BY created_at DESC LIMIT ?`,
						scope.tenantId,
						scope.userId,
						limit,
					),
		)
		return rows.map(rowToRecord)
	}

	/* ------------------------------ internals ---------------------------- */

	/**
	 * Attribution to the document + VERSION the request was taken from.
	 * Access is checked with the same decideDocumentAccess() used by retrieval,
	 * so attribution can never become a read oracle.
	 */
	private resolveSource(
		scope: AccessScope,
		documentId?: string | null,
		versionId?: string | null,
	): ActionSourceAttribution {
		if (!documentId) return EMPTY_SOURCE
		const doc = guardDb(() =>
			this.db.get(`SELECT * FROM documents WHERE id = ? AND tenant_id = ?`, documentId, scope.tenantId),
		)
		if (!doc) {
			throw new GovernedActionError("invalid_input", "The cited source document was not found in your workspace.", {
				sourceDocumentId: "Unknown document.",
			})
		}
		const decision = decideDocumentAccess(scope, {
			tenantId: doc.tenant_id,
			documentId: doc.id,
			department: doc.department,
			classification: doc.classification as Classification,
			allowedRoles: parseJson<string[]>(doc.allowed_roles_json, []),
			allowedUsers: parseJson<string[]>(doc.allowed_users_json, []),
		})
		if (!decision.allowed) {
			throw new GovernedActionError("forbidden", "You are not cleared to cite that document as the source of an action.")
		}
		let versionLabel: string | null = null
		let resolvedVersionId: string | null = null
		if (versionId) {
			const version = guardDb(() =>
				this.db.get(
					`SELECT id, version FROM document_versions WHERE id = ? AND document_id = ? AND tenant_id = ?`,
					versionId,
					doc.id,
					scope.tenantId,
				),
			)
			if (!version) {
				throw new GovernedActionError("invalid_input", "The cited source version does not belong to that document.", {
					sourceVersionId: "Unknown version.",
				})
			}
			resolvedVersionId = version.id
			versionLabel = version.version
		}
		return {
			documentId: doc.id,
			versionId: resolvedVersionId,
			documentTitle: doc.title,
			versionLabel,
		}
	}

	/** A refused proposal is still written, so denials are auditable. */
	private writeDenial(
		id: string,
		definition: ActionDefinition,
		request: ProposeInput,
		reason: string,
		now: string,
	): void {
		const record: ActionRequestRecord = {
			id,
			tenantId: request.scope.tenantId,
			actionId: definition.id,
			actionName: definition.name,
			status: "failed",
			requiredPermission: definition.requiredPermission,
			requestedBy: request.actor,
			authorization: { decision: "denied", reason },
			confirmationRequired: definition.confirmationRequired,
			confirmedAt: null,
			// The rejected payload is NOT stored: it was never validated, so it is
			// unbounded attacker-controlled text. Only the attempt is recorded.
			input: {},
			result: null,
			error: { code: reason === "tenant_mismatch" ? "tenant_mismatch" : "forbidden", message: "Not permitted." },
			executor: this.executor.name,
			simulated: this.executor.simulated,
			conversationId: request.conversationId ?? null,
			source: EMPTY_SOURCE,
			requestId: request.requestId ?? null,
			createdAt: now,
			updatedAt: now,
		}
		try {
			this.insert(record)
			this.audit(record, "Action Denied", "denied", `${definition.id} denied: ${reason}`)
		} catch (error) {
			// The denial itself must never turn a 403 into a 500.
			log.error("action.denial_audit_failed", { detail: (error as Error).message })
		}
	}

	private insert(record: ActionRequestRecord): void {
		this.db.run(
			`INSERT INTO action_requests (
				id, tenant_id, action_id, action_name, status, required_permission,
				requested_by_user_id, requested_by_name, requested_by_email, requested_by_role_key, requested_by_department,
				authorization_decision, authorization_reason, confirmation_required, confirmed_at,
				input_json, result_json, error_code, error_message, executor, simulated,
				conversation_id, source_document_id, source_version_id, source_document_title, source_version_label,
				request_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.id,
			record.tenantId,
			record.actionId,
			record.actionName,
			record.status,
			record.requiredPermission,
			record.requestedBy.userId,
			record.requestedBy.name,
			record.requestedBy.email,
			record.requestedBy.roleKey,
			record.requestedBy.department,
			record.authorization.decision,
			record.authorization.reason,
			record.confirmationRequired ? 1 : 0,
			record.confirmedAt,
			JSON.stringify(record.input),
			record.result ? JSON.stringify(record.result) : null,
			record.error?.code ?? null,
			record.error?.message ?? null,
			record.executor,
			record.simulated ? 1 : 0,
			record.conversationId,
			record.source.documentId,
			record.source.versionId,
			record.source.documentTitle,
			record.source.versionLabel,
			record.requestId,
			record.createdAt,
			record.updatedAt,
		)
	}

	/**
	 * Column-whitelisted partial update. The key list is a closed set defined
	 * here, never a caller-supplied column name.
	 */
	private update(
		id: string,
		tenantId: string,
		patch: Partial<{
			status: ActionStatus
			confirmed_at: string | null
			authorization_decision: "allowed" | "denied"
			authorization_reason: string
			input_json: string
			result_json: string | null
			error_code: string | null
			error_message: string | null
			executor: string
			simulated: 0 | 1
		}>,
	): ActionRequestRecord {
		const allowed = [
			"status",
			"confirmed_at",
			"authorization_decision",
			"authorization_reason",
			"input_json",
			"result_json",
			"error_code",
			"error_message",
			"executor",
			"simulated",
		] as const
		const sets: string[] = []
		const params: any[] = []
		for (const column of allowed) {
			if (!(column in patch)) continue
			sets.push(`${column} = ?`)
			params.push((patch as Record<string, any>)[column])
		}
		sets.push("updated_at = ?")
		params.push(new Date().toISOString())
		this.db.run(`UPDATE action_requests SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, ...params, id, tenantId)
		const row = this.db.get(`SELECT * FROM action_requests WHERE id = ? AND tenant_id = ?`, id, tenantId)
		if (!row) {
			throw new GovernedActionError("database_error", "The action record disappeared while it was being updated.")
		}
		return rowToRecord(row)
	}

	/**
	 * Mirror into the shared activity log so governed actions appear in the
	 * admin audit feed next to sign-ins and knowledge changes. `detail` is a
	 * short summary: never the input payload, which can contain personal data.
	 */
	private audit(
		record: ActionRequestRecord,
		action: string,
		status: "success" | "denied" | "error",
		detail: string,
		latencyMs?: number,
	): void {
		try {
			recordActivity(this.db, {
				tenantId: record.tenantId,
				userId: record.requestedBy.userId,
				userName: record.requestedBy.name,
				action,
				resourceType: "action",
				resourceId: record.id,
				status,
				detail,
				requestId: record.requestId,
				latencyMs: latencyMs ?? null,
			})
		} catch (error) {
			log.error("action.activity_log_failed", { detail: (error as Error).message })
		}
	}
}

export { ACTION_REGISTRY, listActionDefinitions, requireActionDefinition }
