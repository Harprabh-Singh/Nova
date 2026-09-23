/**
 * OData $filter construction for Azure AI Search.
 *
 * This file IS the security boundary for Azure-mode retrieval. It is the exact
 * OData counterpart of `accessSqlFilter()` in backend/src/authorization/policy.ts
 * and must stay semantically identical to it: the local SQLite store and the
 * Azure AI Search store have to make the same access decision for every chunk.
 * `tests/search.test.ts` asserts that equivalence case by case against
 * `decideDocumentAccess()`.
 *
 * Two rules that must never be relaxed:
 *
 * 1. Every value is escaped. OData string literals are single-quoted and escape
 *    an embedded quote by doubling it; nothing else can terminate the literal,
 *    so a correctly escaped value cannot change the shape of the expression.
 * 2. The filter is built from a server-resolved AccessScope only. No part of it
 *    is ever taken from a request body, query string or header.
 */
import type { AccessScope } from "../../authorization/policy.ts"
import { CLASSIFICATION_LEVEL } from "../../models/types.ts"

/**
 * Escapes a value for use inside an OData single-quoted string literal.
 *
 * Control characters are rejected rather than escaped: they never occur in a
 * legitimate tenant id, role key, user id or department, so their presence
 * means something is wrong upstream and failing loudly is safer than encoding.
 */
export function escapeODataString(value: string): string {
	if (typeof value !== "string") throw new TypeError("OData literal must be a string")
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error("Illegal control character in OData filter value")
	}
	return value.replace(/'/g, "''")
}

/** A single-quoted OData literal, safe to concatenate into a filter expression. */
export function odataLiteral(value: string): string {
	return `'${escapeODataString(value)}'`
}

export type SecurityFilterOptions = {
	/**
	 * Default true: ordinary retrieval sees only the active version of an active
	 * document. Historical versions stay indexed for traceability but are
	 * excluded unless a caller explicitly asks for them.
	 */
	onlyActive?: boolean
	/** Optional non-security narrowing, e.g. a department hint from the UI. */
	departments?: string[]
	/** Inverts the ACL clause to select what the caller may NOT see (metadata probes only). */
	negate?: boolean
}

/**
 * The authorization clause, without the tenant/active predicates.
 *
 * Mirrors accessSqlFilter():
 *   admin                -> everything in the tenant
 *   explicit user grant  -> always wins
 *   otherwise            -> (per-department classification reach) AND (role ACL)
 */
function accessClause(scope: AccessScope): string | null {
	if (scope.isAdmin) return null // admins are bounded by the tenant predicate alone

	const departmentClauses: string[] = []
	for (const [department, level] of Object.entries(scope.grants)) {
		if (department === "*") {
			departmentClauses.push(`classificationLevel le ${Number(level)}`)
		} else {
			departmentClauses.push(`(department eq ${odataLiteral(department)} and classificationLevel le ${Number(level)})`)
		}
	}
	// buildAccessScope() always seeds grants['*'], so this can never be empty;
	// the guard keeps a future change from silently producing "allow everything".
	if (departmentClauses.length === 0) return "false"

	const roleAcl = `(not allowedRoles/any() or allowedRoles/any(r: r eq ${odataLiteral(scope.roleKey)}))`
	const userGrant = `allowedUsers/any(u: u eq ${odataLiteral(scope.userId)})`
	return `(${userGrant} or ((${departmentClauses.join(" or ")}) and ${roleAcl}))`
}

/**
 * The single authoritative server-generated security filter for a Search query.
 *
 * It is passed as the request-level `filter`, which Azure AI Search applies to
 * the lexical side and (with the default prefilter mode) to the vector side of
 * a hybrid query alike. Per-vector filter overrides are deliberately NOT used:
 * a vector-level override can replace the global filter and silently drop the
 * tenant and ACL predicates.
 */
export function buildSecurityFilter(scope: AccessScope, options: SecurityFilterOptions = {}): string {
	const clauses: string[] = [`tenantId eq ${odataLiteral(scope.tenantId)}`]

	if (options.onlyActive !== false) {
		clauses.push("documentActive eq true", "versionActive eq true")
	}

	const access = accessClause(scope)
	if (access) clauses.push(options.negate ? `not ${access}` : access)
	else if (options.negate) clauses.push("false") // an admin has nothing out of scope

	if (options.departments?.length) {
		// Non-security narrowing, ANDed on top so it can only ever reduce the result set.
		clauses.push(`(${options.departments.map((d) => `department eq ${odataLiteral(d)}`).join(" or ")})`)
	}

	return clauses.join(" and ")
}

/** Classification name -> the numeric level stored in the index. Single source of truth. */
export function classificationLevel(classification: string): number {
	return CLASSIFICATION_LEVEL[classification as keyof typeof CLASSIFICATION_LEVEL] ?? 99
}
