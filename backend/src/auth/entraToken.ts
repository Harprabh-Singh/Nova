/**
 * Microsoft Entra ID access-token validation.
 *
 * This module does REAL validation, not decoding:
 *
 *   signature  - RS256 verified against the tenant's published JWKS, fetched
 *                through the documented OpenID Connect discovery document
 *                (https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration)
 *   issuer     - must be this tenant's issuer (v2.0 or v1.0 form)
 *   audience   - must be NOVA's own API (api://<clientId>), never another API
 *   tenant     - the `tid` claim must be the configured directory
 *   expiry     - `exp` (and `nbf` when present) with a small configurable skew
 *   scope      - the delegated `access_as_user` scope must be present
 *   identity   - a stable object id (`oid`, or `sub` for v1 tokens that carry
 *                an object id there) is required; name/email/UPN are never
 *                treated as identity
 *
 * Keys and discovery metadata are cached (default one hour). A token signed
 * with an unknown `kid` triggers at most one throttled refresh, so key
 * rollover works without fetching JWKS on every request.
 *
 * Nothing here logs a token, a claim set, or a signing key.
 */
import { createPublicKey, createVerify, timingSafeEqual } from "node:crypto"
import type { EntraConfig } from "../config/index.ts"
import { AuthError } from "./base.ts"

export type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string; use?: string }

export type EntraClaims = {
	/** Stable Entra directory object id. The ONLY identity key NOVA uses. */
	objectId: string
	tenantId: string
	/** Display metadata only. Never used to resolve or authorize a user. */
	displayName: string
	upn: string
	scopes: string[]
	audience: string
	issuer: string
	tokenVersion: string
	expiresAt: number
}

/** Failure categories logged server-side. They are never returned to a client. */
export type ValidationCategory =
	| "malformed"
	| "unsupported_algorithm"
	| "unknown_key"
	| "bad_signature"
	| "expired"
	| "not_yet_valid"
	| "wrong_issuer"
	| "wrong_audience"
	| "wrong_tenant"
	| "missing_scope"
	| "missing_identity"
	| "metadata_unavailable"

export class TokenValidationError extends AuthError {
	constructor(
		readonly category: ValidationCategory,
		statusCode = 401,
	) {
		// A single, uninformative public message: token validation internals,
		// JWT contents and raw Entra errors never reach the caller.
		super("Authentication failed.", statusCode, "unauthenticated")
		this.name = "TokenValidationError"
	}
}

function decodeSegment(segment: string): any {
	return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
}

function equalsConstantTime(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	return left.length === right.length && timingSafeEqual(left, right)
}

/** Fetches and caches the tenant's OIDC metadata and signing keys. */
export class EntraKeyStore {
	private keys: Jwk[] = []
	private fetchedAt = 0
	private lastRefreshAttempt = 0
	private inflight: Promise<Jwk[]> | null = null
	private readonly minRefreshMs = 5 * 60 * 1000

	constructor(
		private readonly config: EntraConfig,
		/** Injectable for tests. Defaults to the real discovery + JWKS fetch. */
		private readonly loader: () => Promise<Jwk[]> = () => defaultJwksLoader(config),
	) {}

	get discoveryUrl(): string {
		return `https://login.microsoftonline.com/${this.config.tenantId}/v2.0/.well-known/openid-configuration`
	}

	private fresh(): boolean {
		return this.keys.length > 0 && Date.now() - this.fetchedAt < this.config.jwksCacheMs
	}

	private async load(): Promise<Jwk[]> {
		if (this.inflight) return this.inflight
		this.inflight = this.loader()
			.then((keys) => {
				this.keys = keys
				this.fetchedAt = Date.now()
				return keys
			})
			.finally(() => {
				this.inflight = null
				this.lastRefreshAttempt = Date.now()
			})
		return this.inflight
	}

	/** Cached lookup, with one throttled refresh when the key id is unknown. */
	async keyFor(kid: string): Promise<Jwk | null> {
		if (!this.fresh()) {
			try {
				await this.load()
			} catch {
				throw new TokenValidationError("metadata_unavailable", 503)
			}
		}
		const hit = this.keys.find((key) => key.kid === kid)
		if (hit) return hit
		// Key rollover: refresh at most once every few minutes, never per request.
		if (Date.now() - this.lastRefreshAttempt > this.minRefreshMs) {
			try {
				await this.load()
			} catch {
				throw new TokenValidationError("metadata_unavailable", 503)
			}
			return this.keys.find((key) => key.kid === kid) ?? null
		}
		return null
	}

	/** Test/ops helper. */
	reset(): void {
		this.keys = []
		this.fetchedAt = 0
		this.lastRefreshAttempt = 0
	}
}

async function defaultJwksLoader(config: EntraConfig): Promise<Jwk[]> {
	const discoveryUrl = `https://login.microsoftonline.com/${config.tenantId}/v2.0/.well-known/openid-configuration`
	const discovery = await fetch(discoveryUrl)
	if (!discovery.ok) throw new Error("discovery_unavailable")
	const metadata = (await discovery.json()) as { jwks_uri?: string; issuer?: string }
	if (!metadata.jwks_uri) throw new Error("discovery_incomplete")
	const jwks = await fetch(metadata.jwks_uri)
	if (!jwks.ok) throw new Error("jwks_unavailable")
	const body = (await jwks.json()) as { keys?: Jwk[] }
	return (body.keys ?? []).filter((key) => key.kty === "RSA" && key.n && key.e)
}

/**
 * Validate one bearer access token. Returns the claims NOVA is allowed to use;
 * every authorization decision happens later, against Neon.
 */
export async function validateEntraAccessToken(
	rawToken: string,
	config: EntraConfig,
	keys: EntraKeyStore,
): Promise<EntraClaims> {
	const token = String(rawToken || "").trim()
	const parts = token.split(".")
	if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new TokenValidationError("malformed")

	let header: { alg?: string; kid?: string; typ?: string }
	let claims: Record<string, any>
	try {
		header = decodeSegment(parts[0])
		claims = decodeSegment(parts[1])
	} catch {
		throw new TokenValidationError("malformed")
	}
	if (!header || typeof header !== "object" || !claims || typeof claims !== "object") {
		throw new TokenValidationError("malformed")
	}
	// "none" and HMAC algorithms are rejected outright: Entra signs with RS256.
	if (header.alg !== "RS256") throw new TokenValidationError("unsupported_algorithm")
	if (!header.kid) throw new TokenValidationError("unknown_key")

	const jwk = await keys.keyFor(header.kid)
	if (!jwk) throw new TokenValidationError("unknown_key")

	let verified = false
	try {
		const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" })
		const verifier = createVerify("RSA-SHA256")
		verifier.update(`${parts[0]}.${parts[1]}`)
		verifier.end()
		verified = verifier.verify(publicKey, Buffer.from(parts[2], "base64url"))
	} catch {
		verified = false
	}
	if (!verified) throw new TokenValidationError("bad_signature")

	/* ---- claim validation (only AFTER the signature is proven) ---- */

	const skew = Math.max(0, config.clockSkewSeconds)
	const now = Math.floor(Date.now() / 1000)
	if (typeof claims.exp !== "number" || claims.exp + skew <= now) throw new TokenValidationError("expired")
	if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new TokenValidationError("not_yet_valid")

	const issuer = String(claims.iss ?? "")
	if (!config.issuers.some((candidate) => equalsConstantTime(candidate, issuer))) {
		throw new TokenValidationError("wrong_issuer")
	}

	const audience = Array.isArray(claims.aud) ? String(claims.aud[0] ?? "") : String(claims.aud ?? "")
	if (!config.audiences.some((candidate) => equalsConstantTime(candidate, audience))) {
		// A Microsoft Graph token, an ID token, or a token for any other API
		// lands here and is refused.
		throw new TokenValidationError("wrong_audience")
	}

	const tid = String(claims.tid ?? "")
	if (!tid || !equalsConstantTime(config.tenantId, tid)) throw new TokenValidationError("wrong_tenant")

	// Delegated user flow only: `scp` carries the consented user scopes.
	// An application-permission token (roles, no scp, idtyp=app) is not a user
	// and must not reach a user-facing NOVA route.
	const scopes = String(claims.scp ?? "")
		.split(/[\s,]+/)
		.filter(Boolean)
	if (!scopes.includes(config.requiredScope)) throw new TokenValidationError("missing_scope")

	// Stable identity. `oid` is the directory object id; v1 tokens for a user
	// repeat it, and only then is `sub` accepted as a fallback carrier.
	const objectId = String(claims.oid ?? "").trim()
	if (!objectId) throw new TokenValidationError("missing_identity")

	return {
		objectId,
		tenantId: tid,
		displayName: String(claims.name ?? "").slice(0, 160),
		upn: String(claims.preferred_username ?? claims.upn ?? "").slice(0, 320),
		scopes,
		audience,
		issuer,
		tokenVersion: String(claims.ver ?? ""),
		expiresAt: claims.exp,
	}
}
