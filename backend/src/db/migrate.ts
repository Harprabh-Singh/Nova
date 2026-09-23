/**
 * Versioned PostgreSQL migrations for production/Azure mode (Neon).
 *
 * - Files: migrations/NNN_name.sql, applied in lexical (= numeric) order.
 * - State: schema_migrations(version, name, checksum, applied_at).
 * - Each file runs in its own transaction together with its bookkeeping row,
 *   so a failed migration leaves no partial state.
 * - A session advisory lock prevents two deploys migrating concurrently.
 * - Re-running is safe: applied versions are skipped; an applied file whose
 *   contents changed is reported as an error instead of being silently re-run.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import pg from "pg"
import { MIGRATIONS_DIR, listMigrationFiles } from "./index.ts"

const LOCK_KEY = 4_815_162_342 // arbitrary, stable advisory-lock id for NOVA migrations

export type MigrationState = { version: string; file: string; checksum: string; appliedAt: string | null; status: "applied" | "pending" | "modified" }

function checksum(sql: string): string {
	return crypto.createHash("sha256").update(sql).digest("hex")
}

async function ensureTable(client: pg.PoolClient | pg.Pool): Promise<void> {
	await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
	await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS name TEXT")
	await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT")
}

export async function migrationStatus(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<MigrationState[]> {
	const exists = await pool.query("SELECT to_regclass('schema_migrations') AS t")
	const applied = new Map<string, { applied_at: string; checksum: string | null }>()
	if (exists.rows[0]?.t) {
		const cols = await pool.query(
			"SELECT column_name FROM information_schema.columns WHERE table_name = 'schema_migrations' AND table_schema = current_schema()",
		)
		const hasChecksum = cols.rows.some((r) => r.column_name === "checksum")
		const rows = await pool.query(`SELECT version, applied_at${hasChecksum ? ", checksum" : ", NULL AS checksum"} FROM schema_migrations`)
		for (const r of rows.rows) applied.set(String(r.version), { applied_at: r.applied_at, checksum: r.checksum })
	}
	return listMigrationFiles(dir).map(({ version, file }) => {
		const sum = checksum(fs.readFileSync(path.join(dir, file), "utf8"))
		const row = applied.get(version)
		if (!row) return { version, file, checksum: sum, appliedAt: null, status: "pending" as const }
		const status = row.checksum && row.checksum !== sum ? ("modified" as const) : ("applied" as const)
		return { version, file, checksum: sum, appliedAt: row.applied_at, status }
	})
}

export async function runMigrations(
	pool: pg.Pool,
	options: { dir?: string; log?: (line: string) => void } = {},
): Promise<{ applied: string[]; skipped: string[] }> {
	const dir = options.dir ?? MIGRATIONS_DIR
	const log = options.log ?? (() => {})
	const client = await pool.connect()
	const applied: string[] = []
	const skipped: string[] = []
	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY])
		try {
			await ensureTable(client)
			const existing = new Map<string, string | null>()
			for (const r of (await client.query("SELECT version, checksum FROM schema_migrations")).rows) existing.set(String(r.version), r.checksum)
			for (const { version, file } of listMigrationFiles(dir)) {
				const sql = fs.readFileSync(path.join(dir, file), "utf8")
				const sum = checksum(sql)
				if (existing.has(version)) {
					const recorded = existing.get(version)
					if (recorded && recorded !== sum) {
						throw new Error(`Migration ${file} was already applied but its contents have changed. Add a new migration instead of editing an applied one.`)
					}
					if (!recorded) await client.query("UPDATE schema_migrations SET name = $2, checksum = $3 WHERE version = $1", [version, file, sum])
					skipped.push(file)
					log(`skip    ${file} (already applied)`)
					continue
				}
				await client.query("BEGIN")
				try {
					await client.query(sql)
					await client.query("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)", [
						version,
						file,
						sum,
						new Date().toISOString(),
					])
					await client.query("COMMIT")
				} catch (error) {
					await client.query("ROLLBACK")
					throw new Error(`Migration ${file} failed and was rolled back: ${(error as Error).message}`)
				}
				applied.push(file)
				log(`applied ${file}`)
			}
		} finally {
			await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {})
		}
	} finally {
		client.release()
	}
	return { applied, skipped }
}
