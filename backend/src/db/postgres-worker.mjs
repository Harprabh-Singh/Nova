/**
 * PostgreSQL worker for the synchronous Database facade (backend/src/db/index.ts).
 *
 * NOVA's repository layer is synchronous (it was written against node:sqlite).
 * To keep every repository/service signature unchanged, the main thread posts a
 * request here and blocks on Atomics.wait until this worker answers through a
 * SharedArrayBuffer. Replies larger than the shared buffer are streamed in chunks.
 *
 * The connection string arrives via workerData and is never logged or echoed.
 */
import { parentPort, workerData } from "node:worker_threads"
import pg from "pg"
import { toPostgresPlaceholders } from "./placeholders.mjs"

const { Pool } = pg
const pool = new Pool({
	connectionString: workerData.connectionString,
	max: 4,
	application_name: workerData.applicationName ?? "nova",
	query_timeout: workerData.queryTimeoutMs,
	connectionTimeoutMillis: workerData.queryTimeoutMs,
})
// Idle-client errors (e.g. Neon closing an idle connection) must not crash the worker.
pool.on("error", () => {})

const meta = new Int32Array(workerData.meta) // [0]=ready flag, [1]=total bytes, [2]=chunk bytes, [3]=request id
const buffer = new Uint8Array(workerData.buffer)
const secrets = (workerData.redact ?? []).filter((s) => typeof s === "string" && s.length >= 3)

let pending = null // { id, bytes }
let txClient = null

function redact(message) {
	let out = String(message ?? "unknown database error")
	for (const secret of secrets) out = out.split(secret).join("[redacted]")
	return out
}

function sendChunk(offset) {
	const part = pending.bytes.subarray(offset, offset + buffer.byteLength)
	buffer.set(part)
	Atomics.store(meta, 1, pending.bytes.byteLength)
	Atomics.store(meta, 2, part.byteLength)
	Atomics.store(meta, 3, pending.id)
	Atomics.store(meta, 0, 1)
	Atomics.notify(meta, 0)
}

/** BYTEA columns come back as Buffers; encode them so they survive JSON transport. */
function encodeValue(value) {
	if (Buffer.isBuffer(value)) return { $b64: value.toString("base64") }
	return value
}
function encodeRow(row) {
	if (!row) return row
	const out = {}
	for (const key of Object.keys(row)) out[key] = encodeValue(row[key])
	return out
}

function reply(id, message) {
	pending = { id, bytes: new TextEncoder().encode(JSON.stringify(message)) }
	sendChunk(0)
}

parentPort.on("message", async (msg) => {
	if (msg.op === "chunk") {
		if (pending && pending.id === msg.id) sendChunk(msg.offset)
		return
	}
	try {
		if (msg.op === "begin") {
			if (txClient) throw new Error("transaction_already_open")
			const client = await pool.connect()
			try {
				await client.query("BEGIN")
			} catch (error) {
				client.release()
				throw error
			}
			txClient = client
			return reply(msg.id, { ok: true, result: null })
		}
		if (msg.op === "commit" || msg.op === "rollback") {
			if (!txClient) throw new Error("transaction_not_open")
			const client = txClient
			txClient = null
			try {
				await client.query(msg.op === "commit" ? "COMMIT" : "ROLLBACK")
			} finally {
				client.release()
			}
			return reply(msg.id, { ok: true, result: null })
		}
		const client = txClient ?? pool
		if (msg.op === "all" || msg.op === "get") {
			const result = await client.query(toPostgresPlaceholders(msg.sql), msg.params)
			const rows = result.rows.map(encodeRow)
			return reply(msg.id, { ok: true, result: msg.op === "get" ? (rows[0] ?? null) : rows })
		}
		if (msg.op === "run") {
			const result = await client.query(toPostgresPlaceholders(msg.sql), msg.params)
			return reply(msg.id, { ok: true, result: { changes: result.rowCount ?? 0 } })
		}
		if (msg.op === "script") {
			// Multi-statement script (no parameters) sent as one simple-protocol query.
			await client.query(msg.sql)
			return reply(msg.id, { ok: true, result: null })
		}
		if (msg.op === "close") {
			if (txClient) {
				txClient.release()
				txClient = null
			}
			await pool.end()
			return reply(msg.id, { ok: true, result: null })
		}
		throw new Error("unsupported_database_operation")
	} catch (error) {
		reply(msg.id, { ok: false, error: redact(error?.message ?? error), code: error?.code ?? null })
	}
})
