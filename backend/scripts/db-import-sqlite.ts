/**
 * npm run db:import-sqlite — one-time copy of an existing local SQLite database into Neon PostgreSQL.
 *
 *   SQLITE_SOURCE=./data/nova.db npm run db:import-sqlite            # import + validate
 *   SQLITE_SOURCE=./data/nova.db npm run db:import-sqlite -- --validate-only
 *
 * Guarantees:
 * - IDs, timestamps, tenant/owner/ACL columns and relationships are copied verbatim.
 * - Rows are inserted in foreign-key order inside ONE transaction.
 * - Any existing PostgreSQL row with the same id is a conflict: the import is
 *   refused and the conflicting ids are reported. Nothing is skipped or overwritten.
 * - After inserting, every table is validated by row count and every row is
 *   compared column-by-column by id. Any mismatch rolls the whole import back.
 * - Referential checks confirm tenant/document/version/conversation links.
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
// @ts-ignore - node:sqlite typings require @types/node >= 22.5.
import { DatabaseSync } from "node:sqlite"
import pg from "pg"
import { getConfig, loadEnv } from "../src/config/index.ts"
import { migrationStatus } from "../src/db/migrate.ts"

export const IMPORT_TABLES = [
	"tenants",
	"roles",
	"permissions",
	"users",
	"documents",
	"document_versions",
	"document_chunks",
	"conversations",
	"messages",
	"citations",
	"activity_logs",
	"incidents",
] as const

/** Relationship checks: every child must point at a parent in the same tenant. */
const RELATIONSHIPS: Array<{ name: string; sql: string }> = [
	{ name: "roles.tenant_id -> tenants", sql: "SELECT COUNT(*) AS n FROM roles c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE t.id IS NULL" },
	{ name: "permissions.tenant_id -> tenants", sql: "SELECT COUNT(*) AS n FROM permissions c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE t.id IS NULL" },
	{ name: "users.tenant_id -> tenants", sql: "SELECT COUNT(*) AS n FROM users c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE t.id IS NULL" },
	{ name: "documents.tenant_id -> tenants", sql: "SELECT COUNT(*) AS n FROM documents c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE t.id IS NULL" },
	{ name: "document_versions -> documents (same tenant)", sql: "SELECT COUNT(*) AS n FROM document_versions v LEFT JOIN documents d ON d.id = v.document_id AND d.tenant_id = v.tenant_id WHERE d.id IS NULL" },
	{ name: "document_chunks -> document_versions (same tenant)", sql: "SELECT COUNT(*) AS n FROM document_chunks c LEFT JOIN document_versions v ON v.id = c.version_id AND v.tenant_id = c.tenant_id AND v.document_id = c.document_id WHERE v.id IS NULL" },
	{ name: "conversations.user_id -> users (same tenant)", sql: "SELECT COUNT(*) AS n FROM conversations c LEFT JOIN users u ON u.id = c.user_id AND u.tenant_id = c.tenant_id WHERE u.id IS NULL" },
	{ name: "messages -> conversations (same tenant)", sql: "SELECT COUNT(*) AS n FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id WHERE c.id IS NULL" },
	{ name: "citations -> messages (same tenant)", sql: "SELECT COUNT(*) AS n FROM citations x LEFT JOIN messages m ON m.id = x.message_id AND m.tenant_id = x.tenant_id WHERE m.id IS NULL" },
	{ name: "activity_logs.tenant_id -> tenants", sql: "SELECT COUNT(*) AS n FROM activity_logs c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE t.id IS NULL" },
	{ name: "incidents.tenant_id -> tenants", sql: "SELECT COUNT(*) AS n FROM incidents c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE t.id IS NULL" },
]

function normalize(value: unknown): string {
	if (value === null || value === undefined) return "∅"
	if (value instanceof Uint8Array) return `b64:${Buffer.from(value).toString("base64")}`
	if (typeof value === "number" || typeof value === "bigint") return `n:${Number(value)}`
	return `s:${String(value)}`
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult<any>> }

export async function validateImport(
	sqlite: InstanceType<typeof DatabaseSync>,
	target: Queryable,
	log: (line: string) => void,
): Promise<string[]> {
	const problems: string[] = []
	for (const table of IMPORT_TABLES) {
		const source = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
		const ids = source.map((r) => String(r.id))
		const found = ids.length ? (await target.query(`SELECT * FROM ${table} WHERE id = ANY($1::text[])`, [ids])).rows : []
		const byId = new Map(found.map((r: any) => [String(r.id), r]))
		let mismatched = 0
		for (const row of source) {
			const other = byId.get(String(row.id))
			if (!other) {
				problems.push(`${table}: id ${row.id} missing in PostgreSQL`)
				mismatched++
				continue
			}
			for (const column of Object.keys(row)) {
				if (normalize(row[column]) !== normalize(other[column])) {
					problems.push(`${table}: id ${row.id} column ${column} differs`)
					mismatched++
				}
			}
		}
		log(`validate ${table.padEnd(18)} sqlite=${source.length} postgres(matched ids)=${found.length} mismatches=${mismatched}`)
	}
	for (const rel of RELATIONSHIPS) {
		// Relationships must be preserved exactly: PostgreSQL may not have more orphans than the source had.
		const inSource = Number((sqlite.prepare(rel.sql).get() as any)?.n ?? 0)
		const inTarget = Number((await target.query(rel.sql)).rows[0]?.n ?? 0)
		if (inTarget !== inSource) problems.push(`relationship ${rel.name}: sqlite orphans=${inSource} postgres orphans=${inTarget}`)
	}
	return problems
}

async function main(): Promise<void> {
	loadEnv()
	const config = getConfig()
	if (config.database.kind !== "postgres") throw new Error("db:import-sqlite requires DATABASE_URL to be a PostgreSQL connection string")
	const validateOnly = process.argv.includes("--validate-only")
	const sqliteFile = process.env.SQLITE_SOURCE ?? "./data/nova.db"
	if (!fs.existsSync(sqliteFile)) {
		console.log(`No SQLite database found at ${sqliteFile}; nothing to migrate.`)
		return
	}
	const sqlite = new DatabaseSync(sqliteFile, { readOnly: true })
	const pool = new pg.Pool({ connectionString: config.database.url, max: 1, application_name: "nova-import" })
	try {
		const pending = (await migrationStatus(pool)).filter((s) => s.status !== "applied")
		if (pending.length) throw new Error(`PostgreSQL has pending migrations (${pending.map((p) => p.file).join(", ")}). Run npm run db:migrate first.`)

		const counts: Record<string, number> = {}
		for (const table of IMPORT_TABLES) counts[table] = Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n)
		console.log(`source ${sqliteFile}: ${IMPORT_TABLES.map((t) => `${t}=${counts[t]}`).join(" ")}`)

		if (validateOnly) {
			const problems = await validateImport(sqlite, pool, (l) => console.log(l))
			if (problems.length) {
				for (const p of problems.slice(0, 200)) console.error(`MISMATCH ${p}`)
				throw new Error(`validation failed with ${problems.length} problem(s)`)
			}
			console.log("validation passed")
			return
		}

		const client = await pool.connect()
		try {
			await client.query("BEGIN")
			// 1. Conflicts: refuse, report, never overwrite.
			const conflicts: string[] = []
			for (const table of IMPORT_TABLES) {
				const ids = (sqlite.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>).map((r) => String(r.id))
				if (!ids.length) continue
				const clash = await client.query(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [ids])
				for (const r of clash.rows) conflicts.push(`${table}:${r.id}`)
			}
			if (conflicts.length) {
				for (const c of conflicts.slice(0, 200)) console.error(`CONFLICT ${c}`)
				throw new Error(`${conflicts.length} row(s) already exist in PostgreSQL with the same id; nothing was imported`)
			}
			// 2. Copy verbatim in foreign-key order (rowid order keeps message tie-break order).
			for (const table of IMPORT_TABLES) {
				const rows = sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]
				for (const row of rows) {
					const columns = Object.keys(row)
					const values = columns.map((c) => (row[c] instanceof Uint8Array ? Buffer.from(row[c] as Uint8Array) : row[c]))
					await client.query(
						`INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
						values,
					)
				}
				console.log(`copied   ${table.padEnd(18)} ${rows.length}`)
			}
			// 3. Validate inside the transaction; any mismatch rolls everything back.
			const problems = await validateImport(sqlite, client, (l) => console.log(l))
			if (problems.length) {
				for (const p of problems.slice(0, 200)) console.error(`MISMATCH ${p}`)
				throw new Error(`validation failed with ${problems.length} problem(s); import rolled back`)
			}
			await client.query("COMMIT")
			console.log("import committed; validation passed")
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {})
			throw error
		} finally {
			client.release()
		}
	} finally {
		sqlite.close()
		await pool.end()
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(`db:import-sqlite failed: ${(error as Error).message}`)
		process.exitCode = 1
	})
}
