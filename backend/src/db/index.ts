/** NOVA data-access layer. Local/demo uses SQLite; Azure/production uses Neon PostgreSQL. */
// @ts-ignore - node:sqlite typings require @types/node >= 22.5.
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import { getConfig } from "../config/index.ts"

export type Row = Record<string, any>

export const SQLITE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, industry TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_admin INTEGER NOT NULL DEFAULT 0, can_create_incidents INTEGER NOT NULL DEFAULT 1, can_upload_knowledge INTEGER NOT NULL DEFAULT 0, UNIQUE (tenant_id, key));
CREATE TABLE IF NOT EXISTS permissions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role_key TEXT NOT NULL, department TEXT NOT NULL, max_classification TEXT NOT NULL, UNIQUE (tenant_id, role_key, department));
CREATE INDEX IF NOT EXISTS idx_permissions_tenant_role ON permissions (tenant_id, role_key);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, role_key TEXT NOT NULL, department TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', entra_object_id TEXT, entra_upn TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, UNIQUE (tenant_id, email));
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_object_id ON users (entra_object_id) WHERE entra_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users (tenant_id, status);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, filename TEXT NOT NULL, department TEXT NOT NULL, category TEXT NOT NULL, classification TEXT NOT NULL, source_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', allowed_roles_json TEXT NOT NULL DEFAULT '[]', allowed_users_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents (tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_tenant_filename ON documents (tenant_id, filename);
CREATE TABLE IF NOT EXISTS document_versions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, document_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', effective_date TEXT NOT NULL, uploaded_at TEXT NOT NULL, uploaded_by TEXT NOT NULL, storage_path TEXT NOT NULL, storage_provider TEXT NOT NULL DEFAULT 'local', storage_container TEXT NOT NULL DEFAULT '', storage_key TEXT, original_filename TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0, checksum TEXT NOT NULL, char_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, ingest_status TEXT NOT NULL DEFAULT 'pending', ingest_error TEXT, UNIQUE (tenant_id, document_id, version), FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_versions_tenant_doc ON document_versions (tenant_id, document_id, status);
CREATE TABLE IF NOT EXISTS document_chunks (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL, seq INTEGER NOT NULL, section TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, char_count INTEGER NOT NULL DEFAULT 0, keywords TEXT NOT NULL DEFAULT '', embedding BLOB, embedding_model TEXT NOT NULL DEFAULT '', injection_flags TEXT NOT NULL DEFAULT '[]', FOREIGN KEY (version_id) REFERENCES document_versions (id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON document_chunks (tenant_id);
CREATE INDEX IF NOT EXISTS idx_chunks_version ON document_chunks (tenant_id, version_id);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL, state_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_user ON conversations (tenant_id, user_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, grounding TEXT, confidence TEXT, provider TEXT, latency_ms INTEGER, action_json TEXT, feedback TEXT, created_at TEXT NOT NULL, FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_conv ON messages (tenant_id, conversation_id, created_at);
CREATE TABLE IF NOT EXISTS citations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, message_id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL, chunk_id TEXT NOT NULL, document_title TEXT NOT NULL, department TEXT NOT NULL, version TEXT NOT NULL, section TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_citations_tenant_msg ON citations (tenant_id, message_id);
CREATE TABLE IF NOT EXISTS activity_logs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, user_name TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, status TEXT NOT NULL, detail TEXT, request_id TEXT, latency_ms INTEGER, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_logs (tenant_id, created_at);
CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, machine_id TEXT NOT NULL, description TEXT NOT NULL, severity TEXT NOT NULL, location TEXT NOT NULL, observed_at TEXT NOT NULL, reporter TEXT NOT NULL, reporter_user_id TEXT, conversation_id TEXT, status TEXT NOT NULL DEFAULT 'open', simulated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE (tenant_id, code));
CREATE INDEX IF NOT EXISTS idx_incidents_tenant ON incidents (tenant_id, created_at);

-- Phase 8 (governed enterprise actions). PostgreSQL gets the same tables
-- through migrations/006_governed_actions.sql.
CREATE TABLE IF NOT EXISTS role_action_permissions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role_key TEXT NOT NULL, action_permission TEXT NOT NULL, granted_at TEXT NOT NULL, granted_by TEXT, UNIQUE (tenant_id, role_key, action_permission));
CREATE INDEX IF NOT EXISTS idx_role_action_permissions_lookup ON role_action_permissions (tenant_id, role_key);
CREATE TABLE IF NOT EXISTS action_requests (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, action_id TEXT NOT NULL, action_name TEXT NOT NULL, status TEXT NOT NULL, required_permission TEXT NOT NULL, requested_by_user_id TEXT NOT NULL, requested_by_name TEXT NOT NULL, requested_by_email TEXT NOT NULL DEFAULT '', requested_by_role_key TEXT NOT NULL, requested_by_department TEXT NOT NULL DEFAULT '', authorization_decision TEXT NOT NULL, authorization_reason TEXT NOT NULL, confirmation_required INTEGER NOT NULL DEFAULT 1, confirmed_at TEXT, input_json TEXT NOT NULL, result_json TEXT, error_code TEXT, error_message TEXT, executor TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 1, conversation_id TEXT, source_document_id TEXT, source_version_id TEXT, source_document_title TEXT, source_version_label TEXT, request_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_action_requests_tenant ON action_requests (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_requests_tenant_user ON action_requests (tenant_id, requested_by_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_requests_status ON action_requests (tenant_id, status);`

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url))

/** Versions of every migration file shipped with this build, in order (e.g. ["001", "002"]). */
export function listMigrationFiles(dir = MIGRATIONS_DIR): Array<{ version: string; file: string }> {
	if (!fs.existsSync(dir)) return []
	return fs
		.readdirSync(dir)
		.filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
		.sort()
		.map((file) => ({ version: file.split("_")[0], file }))
}

export function isPostgresUrl(value: string): boolean {
	return value.startsWith("postgres://") || value.startsWith("postgresql://")
}

/** Values that must never appear in an error message (password, user, host). */
function secretFragments(connectionString: string): string[] {
	try {
		const url = new URL(connectionString)
		return [connectionString, decodeURIComponent(url.password), url.password, url.host, url.hostname].filter(
			(s) => s && s.length >= 3,
		)
	} catch {
		return [connectionString]
	}
}

export class DatabaseError extends Error {
	constructor(
		message: string,
		readonly code: string | null = null,
	) {
		super(message)
		this.name = "DatabaseError"
	}
}

const DEFAULT_QUERY_TIMEOUT_MS = 30_000
const BRIDGE_BUFFER_BYTES = 4 * 1024 * 1024

/**
 * Synchronous facade over an async `pg` pool running in a worker thread. This
 * keeps the existing synchronous repository/service interfaces unchanged.
 * Each call blocks the calling thread until PostgreSQL answers (bounded by a timeout).
 */
class PostgresBridge {
	private worker: Worker | null = null
	private readonly meta = new Int32Array(new SharedArrayBuffer(16))
	private readonly buffer = new Uint8Array(new SharedArrayBuffer(BRIDGE_BUFFER_BYTES))
	private sequence = 0
	private readonly timeoutMs: number

	constructor(
		private readonly connectionString: string,
		private readonly applicationName: string,
	) {
		const configured = Number(process.env.DATABASE_QUERY_TIMEOUT_MS)
		this.timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_QUERY_TIMEOUT_MS
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker
		this.worker = new Worker(new URL("./postgres-worker.mjs", import.meta.url), {
			workerData: {
				connectionString: this.connectionString,
				applicationName: this.applicationName,
				queryTimeoutMs: this.timeoutMs,
				redact: secretFragments(this.connectionString),
				meta: this.meta.buffer,
				buffer: this.buffer.buffer,
			},
		})
		this.worker.unref()
		// Errors are surfaced to callers through the request/timeout path, never logged with connection details.
		this.worker.on("error", () => {})
		return this.worker
	}

	private waitForReply(id: number): void {
		const outcome = Atomics.wait(this.meta, 0, 0, this.timeoutMs + 5_000)
		if (outcome === "timed-out" || Atomics.load(this.meta, 3) !== id) {
			this.worker?.terminate()
			this.worker = null
			throw new DatabaseError("PostgreSQL request timed out or the database worker stopped responding.", "timeout")
		}
	}

	request(op: string, sql = "", params: any[] = []): any {
		const worker = this.ensureWorker()
		const id = ++this.sequence
		Atomics.store(this.meta, 0, 0)
		worker.postMessage({ id, op, sql, params })
		this.waitForReply(id)
		const total = Atomics.load(this.meta, 1)
		const bytes = new Uint8Array(total)
		let received = 0
		for (;;) {
			const size = Atomics.load(this.meta, 2)
			bytes.set(this.buffer.subarray(0, size), received)
			received += size
			if (received >= total) break
			Atomics.store(this.meta, 0, 0)
			worker.postMessage({ id, op: "chunk", offset: received })
			this.waitForReply(id)
		}
		const payload = JSON.parse(new TextDecoder().decode(bytes), (_key, value) =>
			value && typeof value === "object" && typeof value.$b64 === "string" && Object.keys(value).length === 1
				? new Uint8Array(Buffer.from(value.$b64, "base64"))
				: value,
		)
		if (!payload.ok) throw new DatabaseError(payload.error, payload.code)
		return payload.result
	}

	close(): void {
		if (!this.worker) return
		try {
			this.request("close")
		} catch {
			// best effort; terminate below regardless
		}
		this.worker.terminate()
		this.worker = null
	}
}

export type DatabaseOptions = {
	/** Production default: refuse to start unless every shipped migration is applied. */
	verifyMigrations?: boolean
	applicationName?: string
}

export class Database {
	private readonly sqlite?: DatabaseSync
	private readonly postgres?: PostgresBridge
	readonly kind: "sqlite" | "postgres"

	constructor(fileOrUrl: string, options: DatabaseOptions = {}) {
		if (isPostgresUrl(fileOrUrl)) {
			this.kind = "postgres"
			this.postgres = new PostgresBridge(fileOrUrl, options.applicationName ?? "nova")
			if (options.verifyMigrations !== false) {
				try {
					this.verifyPostgresMigrations()
				} catch (error) {
					this.postgres.close()
					throw error
				}
			}
		} else {
			this.kind = "sqlite"
			const file = fileOrUrl.startsWith("file:") ? fileOrUrl.slice(5) : fileOrUrl
			if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
			this.sqlite = new DatabaseSync(file)
			this.sqlite.exec(SQLITE_SCHEMA)
			this.applySqliteAdditions()
		}
	}

	/**
	 * `CREATE TABLE IF NOT EXISTS` never adds a column to an existing local
	 * database, so additive columns are applied here. SQLite has no
	 * `ADD COLUMN IF NOT EXISTS`, hence the pragma check. PostgreSQL gets the
	 * same columns through migrations/004_storage_metadata.sql.
	 */
	private applySqliteAdditions(): void {
		const additions: Array<{ table: string; column: string; ddl: string }> = [
			{ table: "document_versions", column: "storage_provider", ddl: "ALTER TABLE document_versions ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local'" },
			{ table: "document_versions", column: "storage_container", ddl: "ALTER TABLE document_versions ADD COLUMN storage_container TEXT NOT NULL DEFAULT ''" },
			{ table: "document_versions", column: "storage_key", ddl: "ALTER TABLE document_versions ADD COLUMN storage_key TEXT" },
			{ table: "document_versions", column: "original_filename", ddl: "ALTER TABLE document_versions ADD COLUMN original_filename TEXT NOT NULL DEFAULT ''" },
			{ table: "document_versions", column: "mime_type", ddl: "ALTER TABLE document_versions ADD COLUMN mime_type TEXT NOT NULL DEFAULT ''" },
			{ table: "document_versions", column: "size_bytes", ddl: "ALTER TABLE document_versions ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0" },
			// Phase 6 (Entra identity mapping). PostgreSQL gets the same columns
			// through migrations/005_entra_identity.sql.
			{ table: "users", column: "entra_object_id", ddl: "ALTER TABLE users ADD COLUMN entra_object_id TEXT" },
			{ table: "users", column: "entra_upn", ddl: "ALTER TABLE users ADD COLUMN entra_upn TEXT" },
			{ table: "users", column: "status", ddl: "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'" },
		]
		for (const addition of additions) {
			const columns = this.sqlite!.prepare(`PRAGMA table_info(${addition.table})`).all() as Array<{ name: string }>
			if (columns.some((column) => column.name === addition.column)) continue
			this.sqlite!.exec(addition.ddl)
		}
		// One Entra identity maps to exactly one NOVA user.
		this.sqlite!.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_object_id ON users (entra_object_id) WHERE entra_object_id IS NOT NULL",
		)
	}

	private verifyPostgresMigrations(): void {
		let applied: Row[]
		try {
			applied = this.postgres!.request("all", "SELECT version FROM schema_migrations")
		} catch (error: any) {
			if (error?.code === "42P01") {
				throw new DatabaseError("Neon PostgreSQL database is not migrated. Run `npm run db:migrate` before starting NOVA.", "not_migrated")
			}
			throw new DatabaseError(`Could not connect to Neon PostgreSQL (DATABASE_URL): ${error?.message ?? "unknown error"}`, error?.code ?? null)
		}
		const have = new Set(applied.map((r) => String(r.version)))
		const missing = listMigrationFiles().filter((m) => !have.has(m.version))
		if (missing.length) {
			throw new DatabaseError(
				`Neon PostgreSQL database has pending migrations (${missing.map((m) => m.file).join(", ")}). Run \`npm run db:migrate\`.`,
				"pending_migrations",
			)
		}
	}

	all<T = Row>(sql: string, ...params: any[]): T[] {
		return this.kind === "postgres" ? this.postgres!.request("all", sql, params) : (this.sqlite!.prepare(sql).all(...params) as T[])
	}
	get<T = Row>(sql: string, ...params: any[]): T | undefined {
		const row = this.kind === "postgres" ? this.postgres!.request("get", sql, params) : this.sqlite!.prepare(sql).get(...params)
		return (row ?? undefined) as T | undefined
	}
	run(sql: string, ...params: any[]): void {
		if (this.kind === "postgres") this.postgres!.request("run", sql, params)
		else this.sqlite!.prepare(sql).run(...params)
	}
	/** Executes a multi-statement script without parameters (schema/maintenance only). */
	exec(sql: string): void {
		if (this.kind === "postgres") this.postgres!.request("script", sql)
		else this.sqlite!.exec(sql)
	}
	/** All-or-nothing: COMMIT when fn returns, ROLLBACK when it throws (same contract as the SQLite implementation). */
	transaction<T>(fn: () => T): T {
		if (this.kind === "sqlite") {
			this.sqlite!.exec("BEGIN")
			try {
				const result = fn()
				this.sqlite!.exec("COMMIT")
				return result
			} catch (error) {
				this.sqlite!.exec("ROLLBACK")
				throw error
			}
		}
		this.postgres!.request("begin")
		try {
			const result = fn()
			this.postgres!.request("commit")
			return result
		} catch (error) {
			try {
				this.postgres!.request("rollback")
			} catch {
				// the original error is more useful than a rollback failure
			}
			throw error
		}
	}
	close(): void {
		this.postgres?.close()
		this.sqlite?.close()
	}
}

let singleton: Database | null = null
export function getDb(): Database {
	if (!singleton) {
		const config = getConfig()
		singleton = new Database(config.database.url)
	}
	return singleton
}
export function closeDb(): void {
	singleton?.close()
	singleton = null
}
export function createMemoryDb(): Database {
	return new Database(":memory:")
}
export function setDbForTesting(db: Database | null): void {
	singleton = db
}

/** Backwards-compatible alias for the local SQLite schema (pre-Phase-3 name). */
export const SCHEMA = SQLITE_SCHEMA
