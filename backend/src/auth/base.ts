import type { Principal } from "../models/types.ts"

export type AuthSessionRequest = {
	tenantId: string
	/** Demo mode: persona user id. Entra mode: ignored (identity comes from the token). */
	userId?: string
	email?: string
	bearerToken?: string
}

export type AuthSession = {
	token: string
	principal: Principal
	expiresAt: string
	/** Shown verbatim in the UI so demo auth is never mistaken for production auth. */
	notice: string
}

export interface AuthProvider {
	readonly name: string
	readonly mode: "demo" | "entra"
	/** Whether this provider is safe for production use. */
	readonly isProduction: boolean
	createSession(request: AuthSessionRequest): Promise<AuthSession>
	verify(token: string): Promise<Principal | null>
	healthCheck(): Promise<{ ok: boolean; detail: string }>
}

export class AuthError extends Error {
	constructor(
		message: string,
		readonly statusCode = 401,
		/**
		 * Stable machine code. 401 responses use "unauthenticated"; an
		 * authenticated caller who is not authorized inside NOVA gets 403 with
		 * "forbidden" / "identity_not_linked" / "identity_pending".
		 */
		readonly code = statusCode === 403 ? "forbidden" : "unauthenticated",
	) {
		super(message)
		this.name = "AuthError"
	}
}
