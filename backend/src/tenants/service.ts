/**
 * Tenant registry. The company name, departments and assistant labels all come
 * from here - never from hard-coded business logic.
 */
import { randomUUID } from "node:crypto"
import type { Database } from "../db/index.ts"
import type { Permission, Role, Tenant, TenantSettings, User } from "../models/types.ts"
import type { Classification, UserStatus } from "../models/types.ts"

export const DEFAULT_SETTINGS: TenantSettings = {
	departments: ["General"],
	defaultClassification: "internal",
	currency: "INR",
	locale: "en-IN",
	assistantName: "NOVA",
}

function rowToTenant(r: any): Tenant {
	return {
		id: r.id,
		slug: r.slug,
		name: r.name,
		industry: r.industry,
		settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings_json) },
		createdAt: r.created_at,
	}
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 48)
}

export function createTenant(
	db: Database,
	input: { name: string; industry: string; slug?: string; settings?: Partial<TenantSettings> },
): Tenant {
	const slug = input.slug ? slugify(input.slug) : slugify(input.name)
	const existing = getTenantBySlug(db, slug)
	if (existing) return existing
	const tenant: Tenant = {
		id: `ten_${randomUUID()}`,
		slug,
		name: input.name,
		industry: input.industry,
		settings: { ...DEFAULT_SETTINGS, ...input.settings },
		createdAt: new Date().toISOString(),
	}
	db.run(
		`INSERT INTO tenants (id, slug, name, industry, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		tenant.id,
		tenant.slug,
		tenant.name,
		tenant.industry,
		JSON.stringify(tenant.settings),
		tenant.createdAt,
	)
	return tenant
}

export function updateTenantSettings(db: Database, tenantId: string, patch: Partial<TenantSettings>): Tenant {
	const tenant = getTenant(db, tenantId)
	if (!tenant) throw new Error("tenant_not_found")
	const settings = { ...tenant.settings, ...patch }
	db.run(`UPDATE tenants SET settings_json = ? WHERE id = ?`, JSON.stringify(settings), tenantId)
	return { ...tenant, settings }
}

export function getTenant(db: Database, tenantId: string): Tenant | null {
	const row = db.get(`SELECT * FROM tenants WHERE id = ?`, tenantId)
	return row ? rowToTenant(row) : null
}

export function getTenantBySlug(db: Database, slug: string): Tenant | null {
	const row = db.get(`SELECT * FROM tenants WHERE slug = ?`, slug)
	return row ? rowToTenant(row) : null
}

export function listTenants(db: Database): Tenant[] {
	return db.all(`SELECT * FROM tenants ORDER BY created_at`).map(rowToTenant)
}

/* ------------------------------- roles ---------------------------------- */

export function upsertRole(
	db: Database,
	input: {
		tenantId: string
		key: string
		name: string
		description?: string
		isAdmin?: boolean
		canCreateIncidents?: boolean
		canUploadKnowledge?: boolean
	},
): Role {
	const existing = db.get(`SELECT * FROM roles WHERE tenant_id = ? AND key = ?`, input.tenantId, input.key)
	const role: Role = {
		id: existing?.id ?? `rol_${randomUUID()}`,
		tenantId: input.tenantId,
		key: input.key,
		name: input.name,
		description: input.description ?? "",
		isAdmin: input.isAdmin ?? false,
		canCreateIncidents: input.canCreateIncidents ?? true,
		canUploadKnowledge: input.canUploadKnowledge ?? (input.isAdmin ?? false),
	}
	db.run(
		`INSERT INTO roles (id, tenant_id, key, name, description, is_admin, can_create_incidents, can_upload_knowledge)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (tenant_id, key) DO UPDATE SET
		   name = excluded.name,
		   description = excluded.description,
		   is_admin = excluded.is_admin,
		   can_create_incidents = excluded.can_create_incidents,
		   can_upload_knowledge = excluded.can_upload_knowledge`,
		role.id,
		role.tenantId,
		role.key,
		role.name,
		role.description,
		role.isAdmin ? 1 : 0,
		role.canCreateIncidents ? 1 : 0,
		role.canUploadKnowledge ? 1 : 0,
	)
	return role
}

function rowToRole(r: any): Role {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		key: r.key,
		name: r.name,
		description: r.description,
		isAdmin: !!r.is_admin,
		canCreateIncidents: !!r.can_create_incidents,
		canUploadKnowledge: !!r.can_upload_knowledge,
	}
}

export function listRoles(db: Database, tenantId: string): Role[] {
	return db.all(`SELECT * FROM roles WHERE tenant_id = ? ORDER BY key`, tenantId).map(rowToRole)
}

export function getRole(db: Database, tenantId: string, key: string): Role | null {
	const row = db.get(`SELECT * FROM roles WHERE tenant_id = ? AND key = ?`, tenantId, key)
	return row ? rowToRole(row) : null
}

/* ---------------------------- permissions -------------------------------- */

export function grantPermission(
	db: Database,
	input: { tenantId: string; roleKey: string; department: string; maxClassification: Classification },
): Permission {
	const existing = db.get(
		`SELECT * FROM permissions WHERE tenant_id = ? AND role_key = ? AND department = ?`,
		input.tenantId,
		input.roleKey,
		input.department,
	)
	const permission: Permission = {
		id: existing?.id ?? `prm_${randomUUID()}`,
		tenantId: input.tenantId,
		roleKey: input.roleKey,
		department: input.department,
		maxClassification: input.maxClassification,
	}
	db.run(
		`INSERT INTO permissions (id, tenant_id, role_key, department, max_classification) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (tenant_id, role_key, department) DO UPDATE SET max_classification = excluded.max_classification`,
		permission.id,
		permission.tenantId,
		permission.roleKey,
		permission.department,
		permission.maxClassification,
	)
	return permission
}

export function listPermissions(db: Database, tenantId: string, roleKey?: string): Permission[] {
	const rows = roleKey
		? db.all(`SELECT * FROM permissions WHERE tenant_id = ? AND role_key = ?`, tenantId, roleKey)
		: db.all(`SELECT * FROM permissions WHERE tenant_id = ?`, tenantId)
	return rows.map((r) => ({
		id: r.id,
		tenantId: r.tenant_id,
		roleKey: r.role_key,
		department: r.department,
		maxClassification: r.max_classification as Classification,
	}))
}

/* ------------------------ action permissions (Phase 8) ------------------- */

export type ActionPermissionGrant = {
	id: string
	tenantId: string
	roleKey: string
	actionPermission: string
	grantedAt: string
	grantedBy: string | null
}

/**
 * Grant a role the right to REQUEST a governed action.
 *
 * The permission string is the ActionDefinition.requiredPermission value, so
 * the registry in code and the grants in Neon are joined on one literal. A
 * typo grants nothing (it matches no action) rather than granting something
 * unintended - which is the correct failure direction for a write capability.
 * Idempotent: re-granting refreshes the audit fields, it does not duplicate.
 */
export function grantActionPermission(
	db: Database,
	input: { tenantId: string; roleKey: string; actionPermission: string; grantedBy?: string | null },
): ActionPermissionGrant {
	const existing = db.get(
		`SELECT * FROM role_action_permissions WHERE tenant_id = ? AND role_key = ? AND action_permission = ?`,
		input.tenantId,
		input.roleKey,
		input.actionPermission,
	)
	const grant: ActionPermissionGrant = {
		id: existing?.id ?? `apg_${randomUUID()}`,
		tenantId: input.tenantId,
		roleKey: input.roleKey,
		actionPermission: input.actionPermission,
		grantedAt: new Date().toISOString(),
		grantedBy: input.grantedBy ?? null,
	}
	db.run(
		`INSERT INTO role_action_permissions (id, tenant_id, role_key, action_permission, granted_at, granted_by)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (tenant_id, role_key, action_permission)
		 DO UPDATE SET granted_at = excluded.granted_at, granted_by = excluded.granted_by`,
		grant.id,
		grant.tenantId,
		grant.roleKey,
		grant.actionPermission,
		grant.grantedAt,
		grant.grantedBy,
	)
	return grant
}

/** Revoke takes effect immediately, including for an action already proposed. */
export function revokeActionPermission(
	db: Database,
	input: { tenantId: string; roleKey: string; actionPermission: string },
): void {
	db.run(
		`DELETE FROM role_action_permissions WHERE tenant_id = ? AND role_key = ? AND action_permission = ?`,
		input.tenantId,
		input.roleKey,
		input.actionPermission,
	)
}

export function listActionPermissionGrants(db: Database, tenantId: string, roleKey?: string): ActionPermissionGrant[] {
	const rows = roleKey
		? db.all(
				`SELECT * FROM role_action_permissions WHERE tenant_id = ? AND role_key = ? ORDER BY role_key, action_permission`,
				tenantId,
				roleKey,
			)
		: db.all(
				`SELECT * FROM role_action_permissions WHERE tenant_id = ? ORDER BY role_key, action_permission`,
				tenantId,
			)
	return rows.map((r) => ({
		id: r.id,
		tenantId: r.tenant_id,
		roleKey: r.role_key,
		actionPermission: r.action_permission,
		grantedAt: r.granted_at,
		grantedBy: r.granted_by ?? null,
	}))
}

/* -------------------------------- users ---------------------------------- */

function rowToUser(r: any): User {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		name: r.name,
		email: r.email,
		roleKey: r.role_key,
		department: r.department,
		title: r.title,
		entraObjectId: r.entra_object_id ?? null,
		entraUpn: r.entra_upn ?? null,
		status: ((r.status as UserStatus) ?? "active") as UserStatus,
		createdAt: r.created_at,
	}
}

export function upsertUser(
	db: Database,
	input: {
		tenantId: string
		name: string
		email: string
		roleKey: string
		department: string
		title?: string
		/** Optional Entra link. Only administrators reach this path. */
		entraObjectId?: string | null
		entraUpn?: string | null
		status?: UserStatus
	},
): User {
	const existing = db.get(`SELECT * FROM users WHERE tenant_id = ? AND email = ?`, input.tenantId, input.email)
	const user: User = {
		id: existing?.id ?? `usr_${randomUUID()}`,
		tenantId: input.tenantId,
		name: input.name,
		email: input.email,
		roleKey: input.roleKey,
		department: input.department,
		title: input.title ?? "",
		entraObjectId: input.entraObjectId ?? existing?.entra_object_id ?? null,
		entraUpn: input.entraUpn ?? existing?.entra_upn ?? null,
		status: input.status ?? ((existing?.status as UserStatus) ?? "active"),
		createdAt: existing?.created_at ?? new Date().toISOString(),
	}
	db.run(
		`INSERT INTO users (id, tenant_id, name, email, role_key, department, title, entra_object_id, entra_upn, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (tenant_id, email) DO UPDATE SET
		   name = excluded.name, role_key = excluded.role_key,
		   department = excluded.department, title = excluded.title,
		   entra_object_id = excluded.entra_object_id, entra_upn = excluded.entra_upn,
		   status = excluded.status`,
		user.id,
		user.tenantId,
		user.name,
		user.email,
		user.roleKey,
		user.department,
		user.title,
		user.entraObjectId,
		user.entraUpn,
		user.status,
		user.createdAt,
	)
	return user
}

export function listUsers(db: Database, tenantId: string): User[] {
	return db.all(`SELECT * FROM users WHERE tenant_id = ? ORDER BY name`, tenantId).map(rowToUser)
}

export function getUser(db: Database, tenantId: string, userId: string): User | null {
	const row = db.get(`SELECT * FROM users WHERE tenant_id = ? AND id = ?`, tenantId, userId)
	return row ? rowToUser(row) : null
}

export function getUserByEmail(db: Database, tenantId: string, email: string): User | null {
	const row = db.get(`SELECT * FROM users WHERE tenant_id = ? AND email = ?`, tenantId, email)
	return row ? rowToUser(row) : null
}

/* --------------------------- Entra identity link -------------------------- */

/**
 * Resolve a validated Microsoft Entra identity to a NOVA user.
 *
 * The lookup is by object id ONLY and is intentionally not tenant-scoped: the
 * NOVA Entra application is single-tenant, the link is globally unique, and
 * the NOVA tenant is an OUTPUT of this lookup - never an input the browser
 * can influence.
 */
export function getUserByEntraObjectId(db: Database, entraObjectId: string): User | null {
	if (!entraObjectId) return null
	const row = db.get(`SELECT * FROM users WHERE entra_object_id = ?`, entraObjectId)
	return row ? rowToUser(row) : null
}

export class IdentityLinkError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message)
		this.name = "IdentityLinkError"
	}
}

/** Administrator action: bind one Entra object id to one NOVA user. */
export function linkEntraIdentity(
	db: Database,
	input: { tenantId: string; userId: string; entraObjectId: string; entraUpn?: string | null; status?: UserStatus },
): User {
	const user = getUser(db, input.tenantId, input.userId)
	if (!user) throw new IdentityLinkError("User not found in this workspace.", 404)
	const claimed = getUserByEntraObjectId(db, input.entraObjectId)
	if (claimed && claimed.id !== user.id) {
		// No error oracle: the admin only learns the identity is already in use.
		throw new IdentityLinkError("That Microsoft Entra identity is already linked to another NOVA user.", 409)
	}
	db.run(
		`UPDATE users SET entra_object_id = ?, entra_upn = ?, status = ? WHERE tenant_id = ? AND id = ?`,
		input.entraObjectId,
		input.entraUpn ?? user.entraUpn,
		input.status ?? (user.status === "pending" ? "pending" : "active"),
		input.tenantId,
		user.id,
	)
	return getUser(db, input.tenantId, user.id)!
}

export function unlinkEntraIdentity(db: Database, tenantId: string, userId: string): User {
	const user = getUser(db, tenantId, userId)
	if (!user) throw new IdentityLinkError("User not found in this workspace.", 404)
	db.run(`UPDATE users SET entra_object_id = NULL WHERE tenant_id = ? AND id = ?`, tenantId, userId)
	return getUser(db, tenantId, userId)!
}

/** Administrator action: promote a pending Entra user to a real NOVA role. */
export function setUserStatus(db: Database, tenantId: string, userId: string, status: UserStatus): User {
	const user = getUser(db, tenantId, userId)
	if (!user) throw new IdentityLinkError("User not found in this workspace.", 404)
	db.run(`UPDATE users SET status = ? WHERE tenant_id = ? AND id = ?`, status, tenantId, userId)
	return getUser(db, tenantId, userId)!
}

/** Last-seen UPN refresh. Display metadata only; never an authorization input. */
export function touchEntraUpn(db: Database, userId: string, upn: string): void {
	if (!upn) return
	db.run(`UPDATE users SET entra_upn = ? WHERE id = ?`, upn.slice(0, 320), userId)
}
// hist: 2026-09-20T13:22:34+05:30
