/**
 * EntraAuthProvider - production authentication (AUTH_MODE=entra).
 *
 * THE INVARIANT
 * -------------
 *   Microsoft Entra ID authenticates the human   ("who is this?")
 *   Neon authorizes the human inside NOVA        ("which NOVA user, tenant,
 *                                                  role, department,
 *                                                  classification clearance?")
 *
 * Nothing in a token may influence NOVA authorization. The tenant, role,
 * department, permissions and classification clearance are re-read from Neon
 * on EVERY request, from the row the validated Entra object id maps to. A
 * client-supplied tenantId, userId, role, department or classification is
 * ignored here and everywhere downstream, so the AccessScope handed to Azure
 * AI Search (Phase 4) and the document authorization in front of Azure Blob
 * Storage (Phase 5) are unchanged and unbypassable.
 *
 * There is NO silent fallback: a missing configuration fails at startup, an
 * invalid token is 401, and a valid Entra identity with no NOVA user is 403.
 */
import type { AuthProvider, AuthSession, AuthSessionRequest } from "./base.ts"
import { AuthError } from "./base.ts"
import { EntraKeyStore, validateEntraAccessToken, TokenValidationError, type EntraClaims, type Jwk } from "./entraToken.ts"
import type { Database } from "../db/index.ts"
import type { EntraConfig } from "../config/index.ts"
import type { Principal } from "../models/types.ts"
import { getTenant, getUserByEntraObjectId, touchEntraUpn, upsertUser } from "../tenants/service.ts"
import { log } from "../observability/logger.ts"

export type { EntraConfig } from "../config/index.ts"

export class EntraAuthProvider implements AuthProvider {
	readonly name = "EntraAuthProvider"
	readonly mode = "entra" as const
	readonly isProduction = true
	private readonly keys: EntraKeyStore

	constructor(
		private readonly db: Database,
		private readonly config: EntraConfig,
		/** Test seam: supply the JWKS directly instead of fetching Microsoft's. */
		keyLoader?: () => Promise<Jwk[]>,
	) {
		// Configuration is validated in config/index.ts when AUTH_MODE=entra;
		// this is the defensive second line for direct construction.
		if (!config.tenantId || !config.clientId || !config.apiIdUri) {
			throw new AuthError(
				"AUTH_MODE=entra requires ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_API_ID_URI. See docs/azure-integration.md",
				500,
			)
		}
		this.keys = new EntraKeyStore(config, keyLoader)
	}

	/**
	 * NOVA issues no session of its own in Entra mode: the browser performs
	 * Authorization Code + PKCE with MSAL and presents the resulting access
	 * token as `Authorization: Bearer <token>` on every request. This method
	 * exists so the existing /api/session route can echo the resolved NOVA
	 * identity back to the UI after sign-in.
	 */
	async createSession(request: AuthSessionRequest): Promise<AuthSession> {
		if (!request.bearerToken) {
			throw new AuthError(
				"AUTH_MODE=entra: sign in with Microsoft and send the NOVA API access token as a Bearer token.",
				400,
			)
		}
		// request.tenantId / request.userId / request.email are deliberately
		// ignored: identity and tenant come from the token + Neon, never the client.
		const principal = await this.verify(request.bearerToken)
		if (!principal) throw new AuthError("Authentication failed.", 401)
		return {
			token: request.bearerToken,
			principal,
			expiresAt: new Date(this.lastExpiry ?? Date.now() + 60 * 60 * 1000).toISOString(),
			notice: "Signed in with Microsoft Entra ID.",
		}
	}

	private lastExpiry: number | null = null

	async verify(token: string): Promise<Principal | null> {
		let claims: EntraClaims
		try {
			claims = await validateEntraAccessToken(token, this.config, this.keys)
		} catch (error) {
			if (error instanceof TokenValidationError) {
				// Category only. No token, no claims, no signing key, no raw
				// Entra text ever reaches the log or the response body.
				log.warn("auth.token_rejected", { category: error.category })
				throw error
			}
			log.warn("auth.token_rejected", { category: "malformed" })
			return null
		}
		this.lastExpiry = claims.expiresAt * 1000

		const user = this.resolveNovaUser(claims)
		if (!user) {
			log.warn("auth.identity_not_linked", { tenant: claims.tenantId })
			throw new AuthError(
				"Your Microsoft account is not linked to a NOVA user. Ask an administrator for access.",
				403,
				"identity_not_linked",
			)
		}
		if (user.status !== "active") {
			throw new AuthError(
				"Your NOVA access is awaiting administrator approval.",
				403,
				user.status === "pending" ? "identity_pending" : "forbidden",
			)
		}
		// The NOVA tenant comes from the user row. If it is missing, access is
		// denied - a user is never defaulted into the demo tenant.
		if (!user.tenantId || !getTenant(this.db, user.tenantId)) {
			throw new AuthError("Your NOVA workspace is unavailable. Ask an administrator for access.", 403, "tenant_not_linked")
		}
		if (claims.upn && claims.upn !== user.entraUpn) touchEntraUpn(this.db, user.id, claims.upn)

		return {
			// Every authorization attribute below is read from Neon, not the token.
			tenantId: user.tenantId,
			userId: user.id,
			name: user.name,
			email: user.email,
			roleKey: user.roleKey,
			department: user.department,
			title: user.title,
			authMode: "entra",
			entraObjectId: claims.objectId,
		}
	}

	/**
	 * Entra object id -> NOVA user.
	 *
	 * Auto-provisioning is OFF by default: an unknown identity is denied until
	 * an administrator links it (see POST /api/admin/users/:id/entra-link).
	 * When ENTRA_AUTO_PROVISION=true, the first sign-in creates a PENDING user
	 * with the configured privilege-free role in the configured tenant. A role,
	 * department or clearance is NEVER inferred from an email domain, a UPN or
	 * a display name.
	 */
	private resolveNovaUser(claims: EntraClaims) {
		const existing = getUserByEntraObjectId(this.db, claims.objectId)
		if (existing) return existing
		if (!this.config.autoProvision) return null
		const tenant = getTenant(this.db, this.config.autoProvisionTenantId)
		if (!tenant) {
			log.error("auth.auto_provision_tenant_missing", {})
			return null
		}
		const email = claims.upn || `${claims.objectId}@entra.local`
		const created = upsertUser(this.db, {
			tenantId: tenant.id,
			name: claims.displayName || email,
			email,
			roleKey: this.config.autoProvisionRoleKey,
			department: this.config.autoProvisionDepartment,
			title: "",
			entraObjectId: claims.objectId,
			entraUpn: claims.upn || null,
			// Privilege-free until an administrator approves it.
			status: "pending",
		})
		log.info("auth.identity_pending_created", { tenantId: tenant.id, userId: created.id })
		return created
	}

	/**
	 * Local only. /api/health must never contact Entra (zero-token, zero-probe
	 * rule), so this reports configuration completeness, not connectivity.
	 */
	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		const complete = Boolean(this.config.tenantId && this.config.clientId && this.config.apiIdUri && this.config.apiScope)
		return {
			ok: complete,
			detail: complete
				? "Microsoft Entra ID configured (no network probe is performed by health)."
				: "Microsoft Entra ID configuration is incomplete.",
		}
	}
}
