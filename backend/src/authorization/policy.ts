/**
 * Authorization is computed BEFORE retrieval and is pushed down into the query.
 * The LLM never sees content the principal is not allowed to read.
 */
import type { Database } from "../db/index.ts"
import { CLASSIFICATION_LEVEL } from "../models/types.ts"
import type { Classification, Principal } from "../models/types.ts"
import { getRole, listPermissions } from "../tenants/service.ts"

export type AccessScope = {
	tenantId: string
	userId: string
	roleKey: string
	isAdmin: boolean
	canUploadKnowledge: boolean
	canCreateIncidents: boolean
	/** Max readable classification level per department; '*' is the wildcard grant. */
	grants: Record<string, number>
	maxLevelAnywhere: number
	department: string
	/**
	 * Phase 8. Action permission keys granted to this principal's role in this
	 * tenant (e.g. "actions.it.create_request"). Loaded here, with the reading
	 * clearances, so a handler has ONE object that answers both "may they read
	 * this?" and "may they do this?" - there is no second, looser path to a
	 * write capability.
	 */
	actionPermissions: string[]
}

export type DocumentAccessMeta = {
	tenantId: string
	documentId: string
	department: string
	classification: Classification
	allowedRoles: string[]
	allowedUsers: string[]
}

export function buildAccessScope(db: Database, principal: Principal): AccessScope {
	const role = getRole(db, principal.tenantId, principal.roleKey)
	const permissions = listPermissions(db, principal.tenantId, principal.roleKey)
	const grants: Record<string, number> = {}
	for (const p of permissions) {
		const level = CLASSIFICATION_LEVEL[p.maxClassification] ?? 0
		grants[p.department] = Math.max(grants[p.department] ?? 0, level)
	}
	// Everyone can always read public material in their own tenant.
	grants["*"] = Math.max(grants["*"] ?? 0, CLASSIFICATION_LEVEL.public)
	return {
		tenantId: principal.tenantId,
		userId: principal.userId,
		roleKey: principal.roleKey,
		isAdmin: role?.isAdmin ?? false,
		canUploadKnowledge: role?.canUploadKnowledge ?? false,
		canCreateIncidents: role?.canCreateIncidents ?? true,
		grants,
		maxLevelAnywhere: Math.max(...Object.values(grants)),
		department: principal.department,
		actionPermissions: listActionPermissions(db, principal.tenantId, principal.roleKey),
	}
}

/* ----------------------- Phase 8: action authorization ------------------- */

/**
 * The action permissions granted to a role, read straight from Neon.
 *
 * Deliberately a separate table from `permissions`: that one is a READING
 * clearance ("how classified a document may this role open, in which
 * department?"). Being cleared to read the IT policy is not permission to
 * raise a ticket, and conflating the two would make every reader a writer.
 */
export function listActionPermissions(db: Database, tenantId: string, roleKey: string): string[] {
	try {
		return db
			.all(
				`SELECT action_permission FROM role_action_permissions WHERE tenant_id = ? AND role_key = ? ORDER BY action_permission`,
				tenantId,
				roleKey,
			)
			.map((row) => String(row.action_permission))
	} catch {
		// A database that predates migration 006 must not accidentally grant
		// anything: no table means no grants, which means every action is denied.
		return []
	}
}

export type ActionAuthorizationDecision = {
	allowed: boolean
	/** Fixed vocabulary, written to the audit row. Never free text. */
	reason:
		| "admin_role"
		| "role_action_grant"
		| "action_permission_not_granted"
		| "tenant_mismatch"
}

/**
 * Single source of truth for "may this principal perform this action?".
 *
 * The tenant check comes first and compares the scope against the tenant the
 * SERVER resolved for the resource - never against a client-supplied id.
 *
 * Administrators are allowed without an explicit grant. That is a decision,
 * not an oversight: an `is_admin` role can already rewrite the grant table, so
 * refusing it here would be theatre rather than a control. It is still audited
 * distinctly (`admin_role`) so a reviewer can tell a granted action from an
 * administrative one.
 */
export function decideActionAccess(
	scope: AccessScope,
	action: { requiredPermission: string },
	tenantId: string = scope.tenantId,
): ActionAuthorizationDecision {
	if (tenantId !== scope.tenantId) return { allowed: false, reason: "tenant_mismatch" }
	if (scope.isAdmin) return { allowed: true, reason: "admin_role" }
	if (scope.actionPermissions.includes(action.requiredPermission)) {
		return { allowed: true, reason: "role_action_grant" }
	}
	return { allowed: false, reason: "action_permission_not_granted" }
}

export function maxLevelForDepartment(scope: AccessScope, department: string): number {
	return Math.max(scope.grants["*"] ?? 0, scope.grants[department] ?? 0)
}

export type AccessDecision = { allowed: boolean; reason: string }

/** Single source of truth for "may this principal read this document?". */
export function decideDocumentAccess(scope: AccessScope, doc: DocumentAccessMeta): AccessDecision {
	if (doc.tenantId !== scope.tenantId) return { allowed: false, reason: "tenant_mismatch" }
	if (doc.allowedUsers.includes(scope.userId)) return { allowed: true, reason: "explicit_user_grant" }
	if (scope.isAdmin) return { allowed: true, reason: "admin_role" }
	if (doc.allowedRoles.length > 0 && !doc.allowedRoles.includes(scope.roleKey)) {
		return { allowed: false, reason: "role_not_in_document_acl" }
	}
	const needed = CLASSIFICATION_LEVEL[doc.classification] ?? 99
	const allowedLevel = maxLevelForDepartment(scope, doc.department)
	if (needed > allowedLevel) return { allowed: false, reason: "classification_above_clearance" }
	return { allowed: true, reason: "role_grant" }
}

/**
 * SQL fragment implementing the same rule at the data layer, so unauthorized
 * rows are never even loaded into process memory.
 */
export function accessSqlFilter(scope: AccessScope): { sql: string; params: any[] } {
	if (scope.isAdmin) {
		return { sql: "d.tenant_id = ?", params: [scope.tenantId] }
	}
	const deptClauses: string[] = []
	const params: any[] = [scope.tenantId, scope.userId]
	for (const [department, level] of Object.entries(scope.grants)) {
		if (department === "*") {
			deptClauses.push(`(CASE d.classification WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'confidential' THEN 3 WHEN 'restricted' THEN 4 ELSE 99 END) <= ?`)
			params.push(level)
		} else {
			deptClauses.push(
				`(d.department = ? AND (CASE d.classification WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'confidential' THEN 3 WHEN 'restricted' THEN 4 ELSE 99 END) <= ?)`,
			)
			params.push(department, level)
		}
	}
	const roleAclClause = `(d.allowed_roles_json = '[]' OR EXISTS (SELECT 1 FROM json_each(d.allowed_roles_json) WHERE value = ?))`
	const sql = `d.tenant_id = ? AND (
		EXISTS (SELECT 1 FROM json_each(d.allowed_users_json) WHERE value = ?)
		OR ((${deptClauses.join(" OR ")}) AND ${roleAclClause})
	)`
	params.push(scope.roleKey)
	return { sql, params }
}
