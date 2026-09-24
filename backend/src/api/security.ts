/**
 * Edge security for the NOVA HTTP API.
 *
 * Two concerns live here and nowhere else:
 *  1. Rate limiting  - per-identity, per-bucket, configurable, fail-safe.
 *  2. Response headers - the production hardening set.
 *
 * Both are deliberately dependency-free: NOVA runs on node:http with no
 * framework, and the limiter is an in-process fixed-window counter. That is
 * correct for a single-node local/demo deployment. Behind more than one
 * instance the counter must move to a shared store (documented in
 * docs/security.md).
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import { createHash } from "node:crypto"

import { getConfig } from "../config/index.ts"
import { HttpError } from "./http.ts"

/* ------------------------------ rate limiting ---------------------------- */

export type RateBucket = "auth" | "onboarding" | "chat" | "upload" | "action" | "feedback" | "adminWrite" | "read"

export type RateRule = { limit: number; windowMs: number }

/**
 * Defaults are generous enough that a human demo never trips them and tight
 * enough that scripted abuse does. Every value is overridable through env so
 * an operator can tune per deployment without touching code.
 */
export function rateRules(): Record<RateBucket, RateRule> {
	const n = (key: string, fallback: number): number => {
		const value = Number(process.env[key])
		return Number.isFinite(value) && value > 0 ? value : fallback
	}
	const minute = 60_000
	return {
		auth: { limit: n("RATE_LIMIT_AUTH", 20), windowMs: minute },
		onboarding: { limit: n("RATE_LIMIT_ONBOARDING", 5), windowMs: 10 * minute },
		chat: { limit: n("RATE_LIMIT_CHAT", 40), windowMs: minute },
		upload: { limit: n("RATE_LIMIT_UPLOAD", 20), windowMs: 10 * minute },
		action: { limit: n("RATE_LIMIT_ACTION", 30), windowMs: minute },
		feedback: { limit: n("RATE_LIMIT_FEEDBACK", 120), windowMs: minute },
		adminWrite: { limit: n("RATE_LIMIT_ADMIN_WRITE", 60), windowMs: minute },
		read: { limit: n("RATE_LIMIT_READ", 600), windowMs: minute },
	}
}

type Counter = { count: number; resetAt: number }

const counters = new Map<string, Counter>()

/** Test/ops helper - drops every window. */
export function resetRateLimits(): void {
	counters.clear()
}

export function rateLimitDisabled(): boolean {
	return String(process.env.RATE_LIMIT_DISABLED ?? "").toLowerCase() === "true"
}

/**
 * The limiter key. An authenticated caller is limited as that identity, so one
 * noisy tenant cannot exhaust another's budget and a shared NAT address cannot
 * lock out a whole office. Anonymous callers fall back to the socket address.
 * Tokens are hashed - the raw bearer value never becomes a map key.
 */
export function rateKey(req: IncomingMessage, bucket: RateBucket): string {
	const header = req.headers["authorization"]
	const token = typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7) : ""
	if (token) return `${bucket}:t:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`
	const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim()
	return `${bucket}:a:${forwarded || req.socket.remoteAddress || "unknown"}`
}

export type RateDecision = { allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number }

export function consumeRateLimit(req: IncomingMessage, bucket: RateBucket, now = Date.now()): RateDecision {
	const rule = rateRules()[bucket]
	if (rateLimitDisabled()) return { allowed: true, limit: rule.limit, remaining: rule.limit, retryAfterSeconds: 0 }

	const key = rateKey(req, bucket)
	const existing = counters.get(key)
	if (!existing || existing.resetAt <= now) {
		counters.set(key, { count: 1, resetAt: now + rule.windowMs })
		return { allowed: true, limit: rule.limit, remaining: rule.limit - 1, retryAfterSeconds: 0 }
	}

	// Opportunistic sweep so the map cannot grow without bound.
	if (counters.size > 5000) {
		for (const [k, v] of counters) if (v.resetAt <= now) counters.delete(k)
	}

	existing.count += 1
	const remaining = Math.max(0, rule.limit - existing.count)
	if (existing.count > rule.limit) {
		return {
			allowed: false,
			limit: rule.limit,
			remaining: 0,
			retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
		}
	}
	return { allowed: true, limit: rule.limit, remaining, retryAfterSeconds: 0 }
}

/**
 * Enforce a bucket or throw. The 429 body carries no implementation detail -
 * no window size, no counter state, no key - only the retry hint the client
 * genuinely needs.
 */
export function enforceRateLimit(req: IncomingMessage, res: ServerResponse, bucket: RateBucket): void {
	const decision = consumeRateLimit(req, bucket)
	res.setHeader("x-ratelimit-limit", String(decision.limit))
	res.setHeader("x-ratelimit-remaining", String(decision.remaining))
	if (decision.allowed) return
	res.setHeader("retry-after", String(decision.retryAfterSeconds))
	throw new HttpError(429, "Too many requests. Please slow down and try again shortly.", "rate_limited")
}

/* ----------------------------- security headers -------------------------- */

/**
 * The CSP is written against what the app actually loads:
 *  - scripts: only our own bundle (no inline script, no CDN)
 *  - styles:  our own stylesheet plus Google Fonts' stylesheet
 *  - fonts:   Google Fonts' static host
 *  - images:  self, data: and blob: (generated previews)
 *  - connect: self only - the browser never talks to Azure directly
 * 'unsafe-inline' is allowed for style only, because React sets inline style
 * attributes for the motion tokens. It is NOT allowed for script.
 */
export function contentSecurityPolicy(): string {
	return [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
		"font-src 'self' https://fonts.gstatic.com data:",
		"img-src 'self' data: blob:",
		"media-src 'self'",
		"connect-src 'self' https://login.microsoftonline.com",
	].join("; ")
}

/**
 * Applied to every response, API and static alike.
 *
 * HSTS is intentionally conditional: NOVA's local demo is served over plain
 * HTTP on 127.0.0.1, and sending HSTS there would poison the developer's
 * browser for localhost. It is emitted only when the deployment declares TLS
 * via HTTPS_ENABLED=true (or a terminating proxy sets x-forwarded-proto).
 */
export function applySecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
	res.setHeader("content-security-policy", contentSecurityPolicy())
	res.setHeader("x-content-type-options", "nosniff")
	res.setHeader("x-frame-options", "DENY")
	res.setHeader("referrer-policy", "strict-origin-when-cross-origin")
	res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
	res.setHeader("cross-origin-opener-policy", "same-origin")
	res.setHeader("cross-origin-resource-policy", "same-origin")

	/**
	 * HSTS is a browser-wide, long-lived commitment for the whole hostname, so
	 * it is deliberately NOT sent by the local development server: pinning
	 * "localhost" to HTTPS would break every other local project on that name.
	 * It is sent when NOVA itself serves TLS in a non-local deployment, or when
	 * a proxy in front of it terminated HTTPS.
	 */
	const config = getConfig()
	const servesTls = config.server.https && !config.isFullyLocal
	const proxied = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase() === "https"
	if (servesTls || proxied) {
		res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains")
	}
}

/* --------------------------------- CSRF ---------------------------------- */

/**
 * CSRF decision, recorded in code so it is not re-litigated.
 *
 * NOVA authenticates with an `Authorization: Bearer` header that the browser
 * never attaches automatically. A cross-site form or image cannot set that
 * header, so classic CSRF does not apply and a token would be ceremony.
 *
 * What IS still reachable cross-origin is a simple request to an unauthenticated
 * state-changing route. Those are the two below, so they get an Origin check.
 * If the production auth path ever moves to cookies (see docs/security.md),
 * this guard must be extended to every mutating route.
 */
export function assertSameOrigin(req: IncomingMessage): void {
	const origin = req.headers["origin"]
	if (!origin || typeof origin !== "string") return // non-browser client, or same-origin navigation
	const host = String(req.headers["host"] ?? "")
	let originHost = ""
	try {
		originHost = new URL(origin).host
	} catch {
		throw new HttpError(403, "Request blocked.", "forbidden")
	}
	if (originHost !== host) throw new HttpError(403, "Request blocked.", "forbidden")
}

/** True when the deployment is not fully local - used to tighten defaults. */
export function isProductionPosture(): boolean {
	return !getConfig().isFullyLocal
}
// hist: 2026-09-22T07:48:26+05:30
// hist: 2026-09-24T07:31:19+05:30
