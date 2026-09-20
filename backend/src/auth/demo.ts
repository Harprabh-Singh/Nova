/**
 * DemoAuthProvider - LOCAL ONLY.
 * Persona switching for demos. HMAC-signed stateless token, no passwords.
 * This is NOT an authentication system: any persona can be selected freely.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { AuthProvider, AuthSession, AuthSessionRequest } from "./base.ts"
import { AuthError } from "./base.ts"
import type { Database } from "../db/index.ts"
import type { Principal } from "../models/types.ts"
import { getTenant, getUser, getUserByEmail } from "../tenants/service.ts"

export const DEMO_NOTICE = "DEMO PERSONA - local demo authentication, not a real identity provider."

function b64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url")
}

export class DemoAuthProvider implements AuthProvider {
	readonly name = "DemoAuthProvider"
	readonly mode = "demo" as const
	readonly isProduction = false

	constructor(
		private readonly db: Database,
		private readonly secret: string,
		private readonly ttlMs = 12 * 60 * 60 * 1000,
	) {}

	private sign(payload: string): string {
		return createHmac("sha256", this.secret).update(payload).digest("base64url")
	}

	async createSession(request: AuthSessionRequest): Promise<AuthSession> {
		const tenant = getTenant(this.db, request.tenantId)
		if (!tenant) throw new AuthError("Unknown tenant", 404)
		const user = request.userId
			? getUser(this.db, tenant.id, request.userId)
			: request.email
				? getUserByEmail(this.db, tenant.id, request.email)
				: null
		if (!user) throw new AuthError("Unknown demo persona", 404)

		const expiresAt = new Date(Date.now() + this.ttlMs).toISOString()
		const payload = b64url(JSON.stringify({ t: tenant.id, u: user.id, exp: expiresAt, m: "demo" }))
		const token = `${payload}.${this.sign(payload)}`
		return {
			token,
			expiresAt,
			notice: DEMO_NOTICE,
			principal: {
				tenantId: tenant.id,
				userId: user.id,
				name: user.name,
				email: user.email,
				roleKey: user.roleKey,
				department: user.department,
				title: user.title,
				authMode: "demo",
			},
		}
	}

	async verify(token: string): Promise<Principal | null> {
		const [payload, signature] = String(token || "").split(".")
		if (!payload || !signature) return null
		const expected = this.sign(payload)
		const a = Buffer.from(signature)
		const b = Buffer.from(expected)
		if (a.length !== b.length || !timingSafeEqual(a, b)) return null
		let decoded: { t: string; u: string; exp: string }
		try {
			decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
		} catch {
			return null
		}
		if (new Date(decoded.exp).getTime() < Date.now()) return null
		// Identity attributes are re-read from the database on every request, so role
		// or department changes take effect immediately and cannot be spoofed by the client.
		const user = getUser(this.db, decoded.t, decoded.u)
		if (!user) return null
		// A pending or disabled record cannot hold a session, even in demo mode.
		if (user.status !== "active") return null
		return {
			tenantId: user.tenantId,
			userId: user.id,
			name: user.name,
			email: user.email,
			roleKey: user.roleKey,
			department: user.department,
			title: user.title,
			authMode: "demo",
		}
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		return { ok: true, detail: "Local demo authentication active (no identity provider contacted)." }
	}
}
// hist: 2026-09-20T20:14:37+05:30
