/**
 * Shared test fixtures. Every test builds its own in-memory workspace, so the
 * suite never depends on seeded demo data (and never touches Azure).
 *
 * By default `freshDb()` returns a private in-memory SQLite database (fast, no
 * external dependency). Setting NOVA_TEST_DB=postgres plus TEST_DATABASE_URL
 * runs the exact same suite against a throwaway schema on a real PostgreSQL
 * (Neon) server, so the production driver, the `?`->`$n` translation and
 * migration 003 are covered by the full behavioural suite rather than by a
 * separate set of Postgres-only assertions.
 *
 * TEST_DATABASE_URL must be the DIRECT (unpooled) Neon URL: the pooler rejects
 * the `options=-c search_path=...` startup parameter this isolation relies on.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { after } from "node:test"
import { loadEnv } from "../backend/src/config/index.ts"
import { Database, MIGRATIONS_DIR, createMemoryDb, listMigrationFiles, setDbForTesting } from "../backend/src/db/index.ts"
import { createServices, type Services } from "../backend/src/api/server.ts"
import { buildAccessScope, type AccessScope } from "../backend/src/authorization/policy.ts"
import { createTenant, grantPermission, upsertRole, upsertUser } from "../backend/src/tenants/service.ts"
import type { Classification, Principal, Tenant, User } from "../backend/src/models/types.ts"

loadEnv()

export type { Database }

/** Truncation order is irrelevant with CASCADE, but the list is explicit so a new table fails loudly in review. */
const TEST_TABLES = [
	"citations",
	"messages",
	"conversations",
	"document_chunks",
	"document_versions",
	"documents",
	"incidents",
	"action_requests",
	"role_action_permissions",
	"activity_logs",
	"permissions",
	"users",
	"roles",
	"tenants",
]

export const POSTGRES_TEST_URL =
	process.env.NOVA_TEST_DB === "postgres" ? (process.env.TEST_DATABASE_URL ?? "").trim() || undefined : undefined

if (process.env.NOVA_TEST_DB === "postgres" && !POSTGRES_TEST_URL) {
	throw new Error("NOVA_TEST_DB=postgres requires TEST_DATABASE_URL (use the direct/unpooled Neon URL).")
}

function withSearchPath(connectionString: string, schema: string): string {
	const url = new URL(connectionString)
	url.searchParams.set("options", `-c search_path=${schema}`)
	return url.toString()
}

let pgDb: Database | null = null
let pgSchema: string | null = null

/** Creates (once per process) an isolated schema with every shipped migration applied. */
function postgresTestDb(url: string): Database {
	if (pgDb) return pgDb
	const schema = `nova_test_${crypto.randomBytes(6).toString("hex")}`
	const bootstrap = new Database(url, { verifyMigrations: false, applicationName: "nova-test-bootstrap" })
	try {
		bootstrap.exec(`CREATE SCHEMA "${schema}"`)
	} finally {
		bootstrap.close()
	}
	pgSchema = schema
	const db = new Database(withSearchPath(url, schema), { verifyMigrations: false, applicationName: "nova-test" })
	for (const migration of listMigrationFiles()) {
		db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, migration.file), "utf8"))
	}
	pgDb = db
	return db
}

function dropTestSchema(url: string): void {
	if (!pgSchema) return
	const schema = pgSchema
	pgSchema = null
	const cleanup = new Database(url, { verifyMigrations: false, applicationName: "nova-test-cleanup" })
	try {
		cleanup.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
	} finally {
		cleanup.close()
	}
}

if (POSTGRES_TEST_URL) {
	const url = POSTGRES_TEST_URL
	after(() => {
		setDbForTesting(null)
		pgDb?.close()
		pgDb = null
		dropTestSchema(url)
	})
}

export type Actor = { user: User; principal: Principal; scope: AccessScope }

export type Workspace = {
	db: Database
	services: Services
	tenant: Tenant
	actor: (email: string) => Actor
}

/**
 * A database with no rows in it. SQLite gets a brand new in-memory instance;
 * PostgreSQL reuses one connection and truncates, which is both far faster than
 * re-migrating and a stronger test (identity counters restart, so any accidental
 * reliance on sequence values surfaces immediately).
 */
export function freshDb(): Database {
	const db = POSTGRES_TEST_URL ? postgresTestDb(POSTGRES_TEST_URL) : createMemoryDb()
	if (db.kind === "postgres") db.exec(`TRUNCATE TABLE ${TEST_TABLES.join(", ")} RESTART IDENTITY CASCADE`)
	setDbForTesting(db)
	return db
}

export function makeWorkspace(
	db: Database,
	options: {
		name: string
		industry?: string
		departments?: string[]
		users: Array<{ name: string; email: string; roleKey: string; department: string }>
		roles?: Array<{
			key: string
			name: string
			isAdmin?: boolean
			canUploadKnowledge?: boolean
			canCreateIncidents?: boolean
			grants: Array<{ department: string; maxClassification: Classification }>
		}>
	},
): { tenant: Tenant; actor: (email: string) => Actor } {
	const departments = options.departments ?? ["Human Resources", "Engineering", "Operations", "Finance"]
	const tenant = createTenant(db, {
		name: options.name,
		industry: options.industry ?? "Manufacturing",
		settings: { departments },
	})

	const roles = options.roles ?? [
		{ key: "EMPLOYEE", name: "Employee", grants: [{ department: "*", maxClassification: "internal" as Classification }] },
		{
			key: "ADMIN",
			name: "Administrator",
			isAdmin: true,
			canUploadKnowledge: true,
			grants: [{ department: "*", maxClassification: "restricted" as Classification }],
		},
	]
	for (const role of roles) {
		upsertRole(db, {
			tenantId: tenant.id,
			key: role.key,
			name: role.name,
			isAdmin: role.isAdmin ?? false,
			canUploadKnowledge: role.canUploadKnowledge ?? role.isAdmin ?? false,
			canCreateIncidents: role.canCreateIncidents ?? true,
		})
		for (const grant of role.grants) {
			grantPermission(db, {
				tenantId: tenant.id,
				roleKey: role.key,
				department: grant.department,
				maxClassification: grant.maxClassification,
			})
		}
	}

	const users = new Map<string, User>()
	for (const user of options.users) {
		users.set(
			user.email,
			upsertUser(db, {
				tenantId: tenant.id,
				name: user.name,
				email: user.email,
				roleKey: user.roleKey,
				department: user.department,
			}),
		)
	}

	const actor = (email: string): Actor => {
		const user = users.get(email)
		if (!user) throw new Error(`No test user ${email}`)
		const principal: Principal = {
			tenantId: user.tenantId,
			userId: user.id,
			name: user.name,
			email: user.email,
			roleKey: user.roleKey,
			department: user.department,
			title: user.title,
			authMode: "demo",
		}
		return { user, principal, scope: buildAccessScope(db, principal) }
	}

	return { tenant, actor }
}

export function services(db: Database): Services {
	return createServices(db)
}

export async function ingestText(
	svc: Services,
	input: {
		tenantId: string
		filename: string
		text: string
		uploadedBy: string
		department?: string
		classification?: Classification
		version?: string
		allowedRoles?: string[]
		activate?: boolean
	},
) {
	return svc.documents.ingest({
		tenantId: input.tenantId,
		filename: input.filename,
		buffer: Buffer.from(input.text, "utf8"),
		uploadedBy: input.uploadedBy,
		department: input.department,
		classification: input.classification,
		version: input.version,
		allowedRoles: input.allowedRoles,
		activate: input.activate,
		category: "policy",
	})
}
