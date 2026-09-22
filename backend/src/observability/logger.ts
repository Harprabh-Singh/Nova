/**
 * Structured logging + activity audit.
 * Secrets, tokens and full document bodies are never logged (see redact()).
 */
import { randomUUID } from "node:crypto"
import type { Database } from "../db/index.ts"
import type { ActivityLog } from "../models/types.ts"
import { getConfig } from "../config/index.ts"

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

const SECRET_KEY_PATTERN = /(secret|token|password|api[_-]?key|authorization|client[_-]?secret|credential)/i

export function redact(value: unknown): unknown {
	if (value === null || value === undefined) return value
	if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…[truncated]` : value
	if (Array.isArray(value)) return value.map(redact)
	if (typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v)
		}
		return out
	}
	return value
}

function enabled(level: string): boolean {
	const configured = LEVELS[getConfig().server.logLevel] ?? 20
	return (LEVELS[level] ?? 20) >= configured
}

function emit(level: string, event: string, fields: Record<string, unknown>): void {
	if (!enabled(level)) return
	const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) })
	if (level === "error") process.stderr.write(`${line}\n`)
	else process.stdout.write(`${line}\n`)
}

export const log = {
	debug: (event: string, fields: Record<string, unknown> = {}) => emit("debug", event, fields),
	info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
	warn: (event: string, fields: Record<string, unknown> = {}) => emit("warn", event, fields),
	error: (event: string, fields: Record<string, unknown> = {}) => emit("error", event, fields),
}

export function newRequestId(): string {
	return `req_${randomUUID().slice(0, 12)}`
}

export type ActivityInput = {
	tenantId: string
	userId?: string | null
	userName?: string | null
	action: string
	resourceType: string
	resourceId?: string | null
	status: "success" | "denied" | "error"
	detail?: string | null
	requestId?: string | null
	latencyMs?: number | null
}

/** Audit trail. `detail` is a short summary only, never document contents. */
export function recordActivity(db: Database, input: ActivityInput): ActivityLog {
	const row: ActivityLog = {
		id: `act_${randomUUID()}`,
		tenantId: input.tenantId,
		userId: input.userId ?? null,
		userName: input.userName ?? null,
		action: input.action,
		resourceType: input.resourceType,
		resourceId: input.resourceId ?? null,
		status: input.status,
		detail: input.detail ? String(input.detail).slice(0, 240) : null,
		requestId: input.requestId ?? null,
		latencyMs: input.latencyMs ?? null,
		createdAt: new Date().toISOString(),
	}
	db.run(
		`INSERT INTO activity_logs (id, tenant_id, user_id, user_name, action, resource_type, resource_id, status, detail, request_id, latency_ms, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row.id,
		row.tenantId,
		row.userId,
		row.userName,
		row.action,
		row.resourceType,
		row.resourceId,
		row.status,
		row.detail,
		row.requestId,
		row.latencyMs,
		row.createdAt,
	)
	return row
}

export function listActivity(db: Database, tenantId: string, limit = 100): ActivityLog[] {
	return db
		.all(
			`SELECT * FROM activity_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
			tenantId,
			limit,
		)
		.map((r) => ({
			id: r.id,
			tenantId: r.tenant_id,
			userId: r.user_id,
			userName: r.user_name,
			action: r.action,
			resourceType: r.resource_type,
			resourceId: r.resource_id,
			status: r.status,
			detail: r.detail,
			requestId: r.request_id,
			latencyMs: r.latency_ms,
			createdAt: r.created_at,
		}))
}
// hist: 2026-09-22T18:48:07+05:30
