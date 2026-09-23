/**
 * PostgreSQL-specific tests for Phase 3.
 *
 * The behavioural suite (platform/security/health) already runs end to end
 * against PostgreSQL via `NOVA_TEST_DB=postgres npm test`. This file covers the
 * things that suite cannot see: placeholder translation, the migration runner,
 * the SQLite-compatibility shims in migration 003, BYTEA round-trips, the
 * synchronous bridge's chunking, and the importer's validation.
 *
 * Every database test is skipped unless TEST_DATABASE_URL is set, so the default
 * `npm test` stays offline. TEST_DATABASE_URL must be the DIRECT (unpooled) Neon
 * URL, because the pooler rejects `options=-c search_path=...`.
 */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
// @ts-ignore - node:sqlite typings require @types/node >= 22.5.
import { DatabaseSync } from "node:sqlite"
import pg from "pg"
import { Database, DatabaseError, MIGRATIONS_DIR, SQLITE_SCHEMA, isPostgresUrl, listMigrationFiles } from "../backend/src/db/index.ts"
import { migrationStatus, runMigrations } from "../backend/src/db/migrate.ts"
// @ts-ignore - .mjs helper with a hand-written .d.mts
import { toPostgresPlaceholders } from "../backend/src/db/placeholders.mjs"
import { validateImport } from "../backend/scripts/db-import-sqlite.ts"

const BASE_URL = (process.env.TEST_DATABASE_URL ?? "").trim()
const enabled = BASE_URL.length > 0
const skip = enabled ? false : "TEST_DATABASE_URL is not set (direct/unpooled Neon URL required)"

function withSearchPath(schema: string): string {
	const url = new URL(BASE_URL)
	url.searchParams.set("options", `-c search_path=${schema}`)
	return url.toString()
}

describe("sql placeholder translation", () => {
	test("numbers placeholders in order", () => {
		assert.equal(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"), "SELECT * FROM t WHERE a = $1 AND b = $2")
	})
	test("leaves question marks inside string literals alone", () => {
		assert.equal(toPostgresPlaceholders("SELECT '?' , \"c?\" FROM t WHERE a = ?"), "SELECT '?' , \"c?\" FROM t WHERE a = $1")
	})
	test("handles escaped quotes and comments", () => {
		assert.equal(toPostgresPlaceholders("SELECT 'it''s ?' -- ? note\nWHERE a = ?"), "SELECT 'it''s ?' -- ? note\nWHERE a = $1")
	})
	test("no placeholders is a no-op", () => {
		assert.equal(toPostgresPlaceholders("SELECT 1"), "SELECT 1")
	})
	test("recognises postgres urls only", () => {
		assert.equal(isPostgresUrl("postgresql://x/y"), true)
		assert.equal(isPostgresUrl("postgres://x/y"), true)
		assert.equal(isPostgresUrl("./data/nova.db"), false)
		assert.equal(isPostgresUrl(":memory:"), false)
	})
})

describe("postgres migrations", { skip }, () => {
	const schema = `nova_mig_${crypto.randomBytes(6).toString("hex")}`
	let pool: pg.Pool
	let admin: pg.Pool

	before(async () => {
		admin = new pg.Pool({ connectionString: BASE_URL, max: 1 })
		await admin.query(`CREATE SCHEMA "${schema}"`)
		pool = new pg.Pool({ connectionString: BASE_URL, max: 2, options: `-c search_path=${schema}` })
	})
	after(async () => {
		await pool?.end()
		await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
		await admin.end()
	})

	test("applies every shipped migration", async () => {
		const files = listMigrationFiles()
		assert.ok(files.length >= 3, "expected at least migrations 001-003")
		const result = await runMigrations(pool)
		assert.deepEqual(
			result.applied,
			files.map((f) => f.file),
		)
		assert.deepEqual(result.skipped, [])
	})

	test("re-running is a no-op", async () => {
		const result = await runMigrations(pool)
		assert.deepEqual(result.applied, [])
		assert.equal(result.skipped.length, listMigrationFiles().length)
	})

	test("status reports everything applied with checksums", async () => {
		const status = await migrationStatus(pool)
		assert.equal(status.length, listMigrationFiles().length)
		for (const s of status) {
			assert.equal(s.status, "applied", `${s.file} is ${s.status}`)
			assert.ok(s.appliedAt)
		}
	})

	test("an edited applied migration is reported as modified, not re-run", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mig-"))
		for (const { file } of listMigrationFiles()) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file))
		const victim = path.join(dir, listMigrationFiles()[0].file)
		fs.appendFileSync(victim, "\n-- edited after being applied\n")
		const status = await migrationStatus(pool, dir)
		assert.equal(status[0].status, "modified")
		await assert.rejects(() => runMigrations(pool, { dir }), /already applied but its contents have changed/i)
		fs.rmSync(dir, { recursive: true, force: true })
	})

	test("the migrated schema contains every table the SQLite schema defines", async () => {
		const expected = [...SQLITE_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort()
		const rows = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [schema])
		const actual = rows.rows.map((r) => r.table_name as string)
		for (const table of expected) assert.ok(actual.includes(table), `missing table ${table}`)
	})
})

describe("postgres database driver", { skip }, () => {
	const schema = `nova_drv_${crypto.randomBytes(6).toString("hex")}`
	let db: Database
	let admin: pg.Pool

	before(async () => {
		admin = new pg.Pool({ connectionString: BASE_URL, max: 1 })
		await admin.query(`CREATE SCHEMA "${schema}"`)
		const pool = new pg.Pool({ connectionString: BASE_URL, max: 1, options: `-c search_path=${schema}` })
		await runMigrations(pool)
		await pool.end()
		db = new Database(withSearchPath(schema), { applicationName: "nova-pg-test" })
	})
	after(async () => {
		db?.close()
		await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
		await admin.end()
	})

	const TS = "2024-01-01T00:00:00.000Z"

	function seedTenant(id = "t1") {
		db.run("INSERT INTO tenants (id, slug, name, industry, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, id, `Tenant ${id}`, "Manufacturing", "{}", TS)
		return id
	}
	function seedUser(tenant: string, id: string, email: string) {
		db.run("INSERT INTO users (id, tenant_id, name, email, role_key, department, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, tenant, "Ada", email, "ADMIN", "Engineering", "", TS)
	}
	function seedDocument(tenant: string, id: string, allowedUsers = "[]", allowedRoles = "[]", department = "Engineering") {
		db.run(
			"INSERT INTO documents (id, tenant_id, title, filename, department, category, classification, source_type, status, allowed_roles_json, allowed_users_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, tenant, `Doc ${id}`, `${id}.pdf`, department, "policy", "internal", "upload", "active", allowedRoles, allowedUsers, TS, TS,
		)
	}
	function seedVersion(tenant: string, documentId: string, id: string) {
		db.run(
			"INSERT INTO document_versions (id, tenant_id, document_id, version, status, effective_date, uploaded_at, uploaded_by, storage_path, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, tenant, documentId, "1.0", "active", TS, TS, "ada@example.com", `/s/${id}`, "hash",
		)
	}
	function reset() {
		db.exec("TRUNCATE TABLE tenants, roles, permissions, users, documents, document_versions, document_chunks, conversations, messages, citations, activity_logs, incidents RESTART IDENTITY CASCADE")
	}

	test("verifyMigrations accepts a fully migrated database", () => {
		assert.equal(db.kind, "postgres")
		assert.deepEqual(db.get<{ one: number }>("SELECT 1 AS one"), { one: 1 })
	})

	test("refuses to start against an unmigrated database", async () => {
		const empty = `nova_empty_${crypto.randomBytes(4).toString("hex")}`
		await admin.query(`CREATE SCHEMA "${empty}"`)
		try {
			assert.throws(
				() => new Database(withSearchPath(empty), { applicationName: "nova-pg-test" }),
				(error: unknown) => error instanceof DatabaseError && /db:migrate/.test((error as Error).message),
			)
		} finally {
			await admin.query(`DROP SCHEMA IF EXISTS "${empty}" CASCADE`)
		}
	})

	test("never leaks the connection string in errors", () => {
		const bad = new URL(BASE_URL)
		bad.password = "hunter2-should-never-appear"
		bad.hostname = "nova-nonexistent-host.invalid"
		try {
			new Database(bad.toString(), { applicationName: "nova-pg-test" })
			assert.fail("expected a connection failure")
		} catch (error) {
			const text = String((error as Error).message)
			assert.ok(!text.includes("hunter2-should-never-appear"), "password leaked")
			assert.ok(!text.includes(bad.hostname), "host leaked")
		}
	})

	test("crud, parameter binding and cascade deletes", () => {
		reset()
		const tenant = seedTenant("t-crud")
		seedUser(tenant, "u1", "ada@example.com")
		const user = db.get<{ id: string; title: string }>("SELECT id, title FROM users WHERE tenant_id = ? AND email = ?", tenant, "ada@example.com")
		assert.equal(user?.id, "u1")
		assert.equal(user?.title, "")
		assert.equal(db.all("SELECT id FROM users WHERE tenant_id = ?", "nope").length, 0)
		seedDocument(tenant, "d1")
		seedVersion(tenant, "d1", "v1")
		db.run("DELETE FROM documents WHERE id = ?", "d1")
		assert.equal(db.all("SELECT id FROM document_versions WHERE id = ?", "v1").length, 0, "ON DELETE CASCADE must still apply")
	})

	test("NULL parameters round-trip as NULL", () => {
		reset()
		const tenant = seedTenant("t-null")
		db.run(
			"INSERT INTO activity_logs (id, tenant_id, user_id, user_name, action, resource_type, resource_id, status, detail, request_id, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			"a1", tenant, null, null, "login", "user", null, "ok", null, null, null, TS,
		)
		const row = db.get<Record<string, unknown>>("SELECT user_id, detail, latency_ms FROM activity_logs WHERE id = ?", "a1")
		assert.deepEqual(row, { user_id: null, detail: null, latency_ms: null })
	})

	test("transactions commit and roll back", () => {
		reset()
		db.transaction(() => seedTenant("t-commit"))
		assert.equal(db.all("SELECT id FROM tenants WHERE id = ?", "t-commit").length, 1)
		assert.throws(() =>
			db.transaction(() => {
				seedTenant("t-rollback")
				throw new Error("boom")
			}),
		)
		assert.equal(db.all("SELECT id FROM tenants WHERE id = ?", "t-rollback").length, 0, "failed transaction must leave nothing behind")
		assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tenants")?.n), 1, "the connection must be usable after a rollback")
	})

	test("json_each(text) matches SQLite array semantics (migration 003)", () => {
		const rows = db.all<{ key: number; value: string }>(`SELECT key, value FROM json_each('["alice@x.com","bob@x.com"]') ORDER BY key`)
		assert.deepEqual(rows, [
			{ key: 0, value: "alice@x.com" },
			{ key: 1, value: "bob@x.com" },
		])
		assert.equal(db.all(`SELECT 1 FROM json_each(NULL::text)`).length, 0, "NULL must yield no rows (deny, never grant)")
		assert.equal(db.all(`SELECT 1 FROM json_each('[]')`).length, 0)
		assert.equal(
			db.all(`SELECT 1 FROM json_each('["a@x.com"]') WHERE value = ?`, "A@X.COM").length,
			0,
			"matching must be exact, not case-insensitive",
		)
		assert.throws(() => db.all(`SELECT 1 FROM json_each('not json')`), "malformed ACL JSON must error rather than silently grant")
	})

	test("the ACL clause used by authorization/policy.ts behaves identically on postgres", () => {
		reset()
		const tenant = seedTenant("t-acl")
		seedDocument(tenant, "d-open", "[]", "[]")
		seedDocument(tenant, "d-ada", '["ada@example.com"]', "[]")
		seedDocument(tenant, "d-bob", '["bob@example.com"]', "[]", "Finance") // out of department reach: only the user ACL could grant it
		seedDocument(tenant, "d-eng-role", "[]", '["ENGINEER"]')
		seedTenant("t-other")
		seedDocument("t-other", "d-other", '["ada@example.com"]', "[]")

		// The exact shape built by buildDocumentFilter(): direct user grant OR (department reach AND role ACL).
		const sql = `SELECT d.id FROM documents d WHERE d.tenant_id = ? AND (
			EXISTS (SELECT 1 FROM json_each(d.allowed_users_json) WHERE value = ?)
			OR ((d.department = ? OR d.department = '*') AND (d.allowed_roles_json = '[]' OR EXISTS (SELECT 1 FROM json_each(d.allowed_roles_json) WHERE value = ?)))
		) ORDER BY d.id`
		const visible = db.all<{ id: string }>(sql, tenant, "ada@example.com", "Engineering", "ADMIN").map((r) => r.id)
		assert.deepEqual(visible, ["d-ada", "d-open"], "role-restricted and out-of-department documents must stay hidden, and tenant t-other must not leak")

		const engineer = db.all<{ id: string }>(sql, tenant, "nobody@example.com", "Engineering", "ENGINEER").map((r) => r.id)
		assert.deepEqual(engineer, ["d-ada", "d-eng-role", "d-open"])

		const otherTenant = db.all<{ id: string }>(sql, "t-other", "ada@example.com", "Engineering", "ADMIN").map((r) => r.id)
		assert.deepEqual(otherTenant, ["d-other"], "tenant isolation must hold")
	})

	test("BYTEA embeddings round-trip byte for byte", () => {
		reset()
		const tenant = seedTenant("t-vec")
		seedDocument(tenant, "d1")
		seedVersion(tenant, "d1", "v1")
		const floats = Float32Array.from([0, -1.5, 3.25, 1e-8, 12345.75])
		const blob = Buffer.from(floats.buffer)
		db.run(
			"INSERT INTO document_chunks (id, tenant_id, document_id, version_id, seq, section, text, char_count, keywords, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			"c1", tenant, "d1", "v1", 0, "", "hello", 5, "", blob, "local",
		)
		const row = db.get<{ embedding: Uint8Array }>("SELECT embedding FROM document_chunks WHERE id = ?", "c1")
		assert.ok(row?.embedding instanceof Uint8Array, `expected Uint8Array, got ${Object.prototype.toString.call(row?.embedding)}`)
		const out = Buffer.from(row!.embedding)
		assert.equal(out.length, blob.length)
		assert.deepEqual([...new Float32Array(out.buffer, out.byteOffset, floats.length)], [...floats])
		const nul = db.get<{ embedding: unknown }>("SELECT embedding FROM document_chunks WHERE id = ?", "missing")
		assert.equal(nul, undefined)
	})

	test("message ordering matches SQLite insertion order (migration 003 rowid)", () => {
		reset()
		const tenant = seedTenant("t-msg")
		seedUser(tenant, "u1", "ada@example.com")
		db.run("INSERT INTO conversations (id, tenant_id, user_id, title, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "cv1", tenant, "u1", "Chat", "{}", TS, TS)
		for (const id of ["m1", "m2", "m3", "m4"]) {
			db.run("INSERT INTO messages (id, tenant_id, conversation_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, tenant, "cv1", "u1", "user", id, TS)
		}
		const ordered = db.all<{ id: string }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC", "cv1").map((r) => r.id)
		assert.deepEqual(ordered, ["m1", "m2", "m3", "m4"], "identical timestamps must fall back to insertion order")
	})

	test("results larger than the bridge buffer are chunked correctly", () => {
		reset()
		const tenant = seedTenant("t-big")
		seedDocument(tenant, "d1")
		seedVersion(tenant, "d1", "v1")
		const text = "x".repeat(64 * 1024) // 96 rows * 64 KiB = 6 MiB > the 4 MiB bridge buffer
		db.transaction(() => {
			for (let i = 0; i < 96; i++) {
				db.run(
					"INSERT INTO document_chunks (id, tenant_id, document_id, version_id, seq, section, text, char_count, keywords, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					`c${i}`, tenant, "d1", "v1", i, "", text, text.length, "", "local",
				)
			}
		})
		const rows = db.all<{ text: string }>("SELECT text FROM document_chunks WHERE tenant_id = ? ORDER BY seq", tenant)
		assert.equal(rows.length, 96)
		assert.equal(rows.reduce((n, r) => n + r.text.length, 0), 96 * text.length)
	})
})

describe("sqlite -> postgres import validation", { skip }, () => {
	const schema = `nova_imp_${crypto.randomBytes(6).toString("hex")}`
	let pool: pg.Pool
	let admin: pg.Pool
	let sqlite: InstanceType<typeof DatabaseSync>

	before(async () => {
		admin = new pg.Pool({ connectionString: BASE_URL, max: 1 })
		await admin.query(`CREATE SCHEMA "${schema}"`)
		pool = new pg.Pool({ connectionString: BASE_URL, max: 1, options: `-c search_path=${schema}` })
		await runMigrations(pool)
		sqlite = new DatabaseSync(":memory:")
		sqlite.exec(SQLITE_SCHEMA)
	})
	after(async () => {
		sqlite?.close()
		await pool?.end()
		await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
		await admin.end()
	})

	test("an empty source validates cleanly", async () => {
		assert.deepEqual(await validateImport(sqlite, pool, () => {}), [])
	})

	test("a row present in SQLite but missing in PostgreSQL is reported", async () => {
		sqlite.prepare("INSERT INTO tenants (id, slug, name, industry, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("t1", "acme", "Acme", "Manufacturing", "{}", "2024-01-01T00:00:00.000Z")
		const problems = await validateImport(sqlite, pool, () => {})
		assert.ok(problems.some((p) => /tenants: id t1 missing/.test(p)), problems.join("; "))
	})

	test("a differing column value is reported", async () => {
		await pool.query("INSERT INTO tenants (id, slug, name, industry, settings_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)", ["t1", "acme", "Acme CHANGED", "Manufacturing", "{}", "2024-01-01T00:00:00.000Z"])
		const problems = await validateImport(sqlite, pool, () => {})
		assert.ok(problems.some((p) => /tenants: id t1 column name differs/.test(p)), problems.join("; "))
	})

	test("an identical row validates cleanly", async () => {
		await pool.query("UPDATE tenants SET name = $1 WHERE id = $2", ["Acme", "t1"])
		assert.deepEqual(await validateImport(sqlite, pool, () => {}), [])
	})
})
