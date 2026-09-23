/**
 * Phase 6 authentication suite: Microsoft Entra ID + NOVA identity mapping.
 *
 * Everything runs in-process. No network call is made: the JWKS is injected
 * into the provider, and every token is minted locally with a throwaway RSA
 * key, so the real signature/issuer/audience/tenant/scope/expiry checks are
 * exercised without contacting Microsoft.
 *
 * The invariant under test:
 *   Entra says WHO the human is. Neon says WHAT they may do inside NOVA.
 */
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"

import { ConfigError, getConfig, resetConfigCache, type EntraConfig } from "../backend/src/config/index.ts"
import { EntraAuthProvider } from "../backend/src/auth/entra.ts"
import { DemoAuthProvider } from "../backend/src/auth/demo.ts"
import { createAuthProvider } from "../backend/src/auth/index.ts"
import { AuthError } from "../backend/src/auth/base.ts"
import type { Jwk } from "../backend/src/auth/entraToken.ts"
import { buildAccessScope, decideDocumentAccess } from "../backend/src/authorization/policy.ts"
import { getUserByEntraObjectId, linkEntraIdentity, setUserStatus } from "../backend/src/tenants/service.ts"
import { freshDb, makeWorkspace } from "./helpers.ts"

/* ------------------------------ test crypto ------------------------------ */

const TENANT = "191223fe-a651-4b8c-a79d-8b368bba577d"
const CLIENT = "9bb0d161-2be5-4d0c-b5f5-8c54211c0d1d"
const API_ID_URI = `api://${CLIENT}`

const signing = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
const attacker = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
const KID = "nova-test-key"

function jwks(): Jwk[] {
	const jwk = signing.publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string }
	return [{ kid: KID, kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" }]
}

function entraConfig(overrides: Partial<EntraConfig> = {}): EntraConfig {
	return {
		tenantId: TENANT,
		clientId: CLIENT,
		apiIdUri: API_ID_URI,
		apiScope: `${API_ID_URI}/access_as_user`,
		requiredScope: "access_as_user",
		authority: `https://login.microsoftonline.com/${TENANT}`,
		redirectUri: "http://localhost:4317",
		postLogoutRedirectUri: "http://localhost:4317",
		audiences: [API_ID_URI, CLIENT],
		issuers: [`https://login.microsoftonline.com/${TENANT}/v2.0`, `https://sts.windows.net/${TENANT}/`],
		jwksCacheMs: 3_600_000,
		clockSkewSeconds: 60,
		autoProvision: false,
		autoProvisionTenantId: "",
		autoProvisionRoleKey: "PENDING",
		autoProvisionDepartment: "Unassigned",
		...overrides,
	}
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

type ClaimOverrides = Record<string, unknown>

function mintToken(claims: ClaimOverrides = {}, options: { key?: crypto.KeyObject; kid?: string; alg?: string } = {}): string {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT" }
	const payload = {
		iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
		aud: API_ID_URI,
		tid: TENANT,
		oid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		sub: "subject-value",
		scp: "access_as_user",
		name: "Real Person",
		preferred_username: "real.person@contoso.com",
		ver: "2.0",
		iat: now - 30,
		nbf: now - 30,
		exp: now + 3600,
		...claims,
	}
	const signingInput = `${b64(header)}.${b64(payload)}`
	const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), options.key ?? signing.privateKey)
	return `${signingInput}.${signature.toString("base64url")}`
}

function provider(db: ReturnType<typeof freshDb>, config: Partial<EntraConfig> = {}) {
	return new EntraAuthProvider(db, entraConfig(config), async () => jwks())
}

/** A workspace with a linked Entra identity on the employee. */
function linkedWorkspace(db: ReturnType<typeof freshDb>, objectId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") {
	const workspace = makeWorkspace(db, {
		name: "NovaTech",
		departments: ["Human Resources", "Operations", "Engineering", "Management"],
		roles: [
			{ key: "EMPLOYEE", name: "Employee", grants: [{ department: "*", maxClassification: "internal" }] },
			{
				key: "ADMIN",
				name: "Administrator",
				isAdmin: true,
				canUploadKnowledge: true,
				grants: [{ department: "*", maxClassification: "restricted" }],
			},
		],
		users: [
			{ name: "Alex Mendes", email: "alex@novatech.example", roleKey: "EMPLOYEE", department: "Operations" },
			{ name: "Admin User", email: "admin@novatech.example", roleKey: "ADMIN", department: "Management" },
		],
	})
	const employee = workspace.actor("alex@novatech.example").user
	linkEntraIdentity(db, { tenantId: workspace.tenant.id, userId: employee.id, entraObjectId: objectId })
	return { ...workspace, employee }
}

async function expectStatus(promise: Promise<unknown>, status: number, codeMatch?: RegExp): Promise<AuthError> {
	try {
		const value = await promise
		assert.fail(`expected ${status}, got a successful result: ${JSON.stringify(value)}`)
	} catch (error) {
		assert.ok(error instanceof AuthError, `expected AuthError, got ${String(error)}`)
		assert.equal((error as AuthError).statusCode, status)
		if (codeMatch) assert.match((error as AuthError).code, codeMatch)
		return error as AuthError
	}
}

/* ============================== CONFIGURATION ============================= */

const ENV_KEYS = [
	"APP_MODE",
	"AI_MODE",
	"KNOWLEDGE_MODE",
	"AUTH_MODE",
	"ACTION_MODE",
	"VECTOR_STORE",
	"STORAGE_MODE",
	"DATABASE_URL",
	"PORT",
	"ENTRA_TENANT_ID",
	"ENTRA_CLIENT_ID",
	"ENTRA_API_ID_URI",
	"ENTRA_API_SCOPE",
	"ENTRA_AUTHORITY",
	"ENTRA_REDIRECT_URI",
	"ENTRA_CLIENT_SECRET",
	"ENTRA_AUDIENCE",
	"ENTRA_AUTO_PROVISION",
	"ENTRA_AUTO_PROVISION_TENANT_ID",
	"AZURE_TENANT_ID",
	"AZURE_CLIENT_ID",
	"AZURE_CLIENT_SECRET",
]

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
	const previous = new Map<string, string | undefined>()
	for (const key of ENV_KEYS) {
		previous.set(key, process.env[key])
		delete process.env[key]
	}
	for (const [key, value] of Object.entries(env)) process.env[key] = value
	resetConfigCache()
	try {
		return fn()
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		resetConfigCache()
	}
}

const VALID_ENTRA_ENV = {
	AUTH_MODE: "entra",
	DATABASE_URL: "postgresql://user:pass@example.neon.tech/nova",
	ENTRA_TENANT_ID: TENANT,
	ENTRA_CLIENT_ID: CLIENT,
	ENTRA_API_ID_URI: API_ID_URI,
	ENTRA_API_SCOPE: `${API_ID_URI}/access_as_user`,
	ENTRA_AUTHORITY: `https://login.microsoftonline.com/${TENANT}`,
	ENTRA_REDIRECT_URI: "http://localhost:4317",
}

test("a complete single-tenant Entra configuration is accepted", () => {
	withEnv(VALID_ENTRA_ENV, () => {
		const config = getConfig()
		assert.equal(config.modes.authMode, "entra")
		assert.equal(config.entra.tenantId, TENANT)
		assert.equal(config.entra.clientId, CLIENT)
		assert.deepEqual(config.entra.audiences, [API_ID_URI, CLIENT])
		assert.equal(config.entra.requiredScope, "access_as_user")
		// The redirect origin is deterministic and port fallback is off.
		assert.equal(config.server.port, 4317)
		assert.equal(config.server.allowPortFallback, false)
	})
})

test("demo mode keeps automatic port fallback", () => {
	withEnv({}, () => {
		assert.equal(getConfig().server.allowPortFallback, true)
	})
})

test("Entra mode rejects an invalid tenant id", () => {
	withEnv({ ...VALID_ENTRA_ENV, ENTRA_TENANT_ID: "contoso", ENTRA_AUTHORITY: "https://login.microsoftonline.com/contoso" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => error instanceof ConfigError && /tenant\) GUID/.test((error as Error).message))
	})
})

test("Entra mode rejects a malformed or multi-tenant authority", () => {
	for (const authority of [
		"https://login.microsoftonline.com/common",
		"https://login.microsoftonline.com/organizations",
		"https://evil.example/191223fe-a651-4b8c-a79d-8b368bba577d",
	]) {
		withEnv({ ...VALID_ENTRA_ENV, ENTRA_AUTHORITY: authority }, () => {
			assert.throws(
				() => getConfig(),
				(error: unknown) => error instanceof ConfigError && /ENTRA_AUTHORITY must be exactly/.test((error as Error).message),
				`expected ${authority} to be refused`,
			)
		})
	}
})

test("Entra mode refuses to start without a client id, an API identifier or a redirect URI", () => {
	// No client id at all: the Application ID URI and scope cannot be derived.
	const noClient: Record<string, string> = { ...VALID_ENTRA_ENV }
	delete noClient.ENTRA_CLIENT_ID
	delete noClient.ENTRA_API_ID_URI
	delete noClient.ENTRA_API_SCOPE
	withEnv(noClient, () => {
		assert.throws(
			() => getConfig(),
			(error: unknown) => error instanceof ConfigError && /ENTRA_CLIENT_ID/.test((error as Error).message),
		)
	})

	// No redirect URI: there is no deterministic origin to register.
	const noRedirect: Record<string, string> = { ...VALID_ENTRA_ENV }
	delete noRedirect.ENTRA_REDIRECT_URI
	withEnv(noRedirect, () => {
		assert.throws(
			() => getConfig(),
			(error: unknown) => error instanceof ConfigError && /ENTRA_REDIRECT_URI/.test((error as Error).message),
		)
	})

	// No tenant id: no authority and no issuer can be built.
	const noTenant: Record<string, string> = { ...VALID_ENTRA_ENV }
	delete noTenant.ENTRA_TENANT_ID
	delete noTenant.ENTRA_AUTHORITY
	withEnv(noTenant, () => {
		assert.throws(
			() => getConfig(),
			(error: unknown) => error instanceof ConfigError && /ENTRA_TENANT_ID/.test((error as Error).message),
		)
	})
})

test("Entra mode refuses a scope that is not access_as_user on the NOVA API", () => {
	withEnv({ ...VALID_ENTRA_ENV, ENTRA_API_SCOPE: "https://graph.microsoft.com/User.Read" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => error instanceof ConfigError && /ENTRA_API_SCOPE/.test((error as Error).message))
	})
})

test("Entra mode refuses a client secret: the SPA is a public client", () => {
	withEnv({ ...VALID_ENTRA_ENV, ENTRA_CLIENT_SECRET: "must-not-exist" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => error instanceof ConfigError && /PUBLIC client/.test((error as Error).message))
	})
})

test("Entra mode refuses a PORT that contradicts the registered redirect URI", () => {
	withEnv({ ...VALID_ENTRA_ENV, PORT: "5000" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => error instanceof ConfigError && /registered redirect origin/.test((error as Error).message))
	})
})

test("demo mode never requires Entra configuration", () => {
	withEnv({ AUTH_MODE: "demo" }, () => {
		const config = getConfig()
		assert.equal(config.modes.authMode, "demo")
		assert.equal(config.isFullyLocal, true)
	})
})

/* ============================ TOKEN VALIDATION ============================ */

test("a valid access token resolves to the mapped NOVA user", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const principal = await provider(db).verify(mintToken())
	assert.ok(principal)
	assert.equal(principal!.userId, workspace.employee.id)
	assert.equal(principal!.tenantId, workspace.tenant.id)
	assert.equal(principal!.authMode, "entra")
	assert.equal(principal!.roleKey, "EMPLOYEE")
})

test("a token signed by another key is rejected", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	await expectStatus(provider(db).verify(mintToken({}, { key: attacker.privateKey })), 401, /unauthenticated/)
})

test("an expired token is rejected", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	const past = Math.floor(Date.now() / 1000) - 7200
	await expectStatus(provider(db).verify(mintToken({ exp: past, nbf: past - 60, iat: past - 60 })), 401)
})

test("a token from the wrong issuer is rejected", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	await expectStatus(provider(db).verify(mintToken({ iss: "https://login.microsoftonline.com/other/v2.0" })), 401)
})

test("a token for another audience (including Microsoft Graph) is rejected", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	for (const aud of ["https://graph.microsoft.com", "api://some-other-api", "00000003-0000-0000-c000-000000000000"]) {
		await expectStatus(provider(db).verify(mintToken({ aud })), 401)
	}
})

test("a token without the access_as_user scope is rejected", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	await expectStatus(provider(db).verify(mintToken({ scp: "openid profile" })), 401)
	// An application-permission token carries roles and no scp: also refused.
	await expectStatus(provider(db).verify(mintToken({ scp: undefined, roles: ["Nova.ReadAll"] })), 401)
})

test("a token from another directory is rejected", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	await expectStatus(provider(db).verify(mintToken({ tid: "00000000-0000-0000-0000-000000000001" })), 401)
})

test("malformed tokens and unsigned alg=none tokens are rejected", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	const p = provider(db)
	for (const token of ["", "not-a-token", "a.b", "a.b.c"]) {
		const result = await p.verify(token).catch((error) => error)
		assert.ok(result === null || result instanceof AuthError, `expected rejection for "${token}"`)
	}
	const none = `${b64({ alg: "none", kid: KID })}.${b64({ oid: "x" })}.`
	const result = await p.verify(none).catch((error) => error)
	assert.ok(result === null || result instanceof AuthError)
})

test("an unknown signing key is rejected without trusting the token", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	await expectStatus(provider(db).verify(mintToken({}, { kid: "unknown-kid" })), 401)
})

test("JWKS is cached: repeated verification does not refetch keys", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	let loads = 0
	const p = new EntraAuthProvider(db, entraConfig(), async () => {
		loads += 1
		return jwks()
	})
	await p.verify(mintToken())
	await p.verify(mintToken())
	await p.verify(mintToken())
	assert.equal(loads, 1)
})

/* ============================== USER MAPPING ============================== */

test("a valid Entra identity with no NOVA user is denied with 403, never defaulted", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	await expectStatus(provider(db).verify(mintToken({ oid: "99999999-9999-9999-9999-999999999999" })), 403, /identity_not_linked/)
})

test("a pending (auto-provisioned) user is authenticated but not authorized", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	setUserStatus(db, workspace.tenant.id, workspace.employee.id, "pending")
	await expectStatus(provider(db).verify(mintToken()), 403, /identity_pending/)
})

test("auto-provisioning creates a privilege-free pending user and never an admin", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const p = provider(db, { autoProvision: true, autoProvisionTenantId: workspace.tenant.id })
	await expectStatus(p.verify(mintToken({ oid: "11111111-2222-3333-4444-555555555555" })), 403, /identity_pending/)
	const created = getUserByEntraObjectId(db, "11111111-2222-3333-4444-555555555555")
	assert.ok(created)
	assert.equal(created!.status, "pending")
	assert.equal(created!.roleKey, "PENDING")
	assert.notEqual(created!.roleKey, "ADMIN")
	assert.equal(buildAccessScope(db, {
		tenantId: created!.tenantId,
		userId: created!.id,
		name: created!.name,
		email: created!.email,
		roleKey: created!.roleKey,
		department: created!.department,
		title: created!.title,
		authMode: "entra",
	}).isAdmin, false)
})

test("identity is keyed on the Entra object id, not on email, UPN or display name", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	// Same person, renamed and with a new UPN: the mapping still holds.
	const principal = await provider(db).verify(
		mintToken({ name: "Alex Married-Name", preferred_username: "alex.new@novatech.example" }),
	)
	assert.equal(principal!.userId, workspace.employee.id)
	// A matching email with a DIFFERENT object id does not map to that user.
	await expectStatus(
		provider(db).verify(mintToken({ oid: "77777777-7777-7777-7777-777777777777", preferred_username: "alex@novatech.example" })),
		403,
		/identity_not_linked/,
	)
})

test("one Entra identity cannot be linked to two NOVA users", () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const admin = workspace.actor("admin@novatech.example").user
	assert.throws(() =>
		linkEntraIdentity(db, {
			tenantId: workspace.tenant.id,
			userId: admin.id,
			entraObjectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		}),
	)
})

/* ================================ SECURITY ================================ */

test("client-supplied tenant, user, role, department and classification are ignored", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const other = makeWorkspace(db, {
		name: "Acme Logistics",
		users: [{ name: "Intruder", email: "intruder@acme.example", roleKey: "ADMIN", department: "Management" }],
	})
	const session = await provider(db).createSession({
		// Every one of these is attacker-controlled input.
		tenantId: other.tenant.id,
		userId: other.actor("intruder@acme.example").user.id,
		email: "intruder@acme.example",
		bearerToken: mintToken({
			nova_tenant_id: other.tenant.id,
			tenant: other.tenant.id,
			roles: ["ADMIN"],
			role: "ADMIN",
			department: "Finance",
			classification: "restricted",
			extension_novaRole: "ADMIN",
		}),
	})
	assert.equal(session.principal.tenantId, workspace.tenant.id)
	assert.equal(session.principal.userId, workspace.employee.id)
	assert.equal(session.principal.roleKey, "EMPLOYEE")
	assert.equal(session.principal.department, "Operations")
	const scope = buildAccessScope(db, session.principal)
	assert.equal(scope.isAdmin, false)
	assert.equal(scope.tenantId, workspace.tenant.id)
})

test("a demo session token is worthless in Entra mode (no silent fallback)", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const demo = new DemoAuthProvider(db, "local-dev-only-change-me")
	const demoSession = await demo.createSession({ tenantId: workspace.tenant.id, email: "alex@novatech.example" })
	// The demo HMAC token is not a JWT and carries no Entra signature.
	const result = await provider(db).verify(demoSession.token).catch((error) => error)
	assert.ok(result === null || result instanceof AuthError)
})

test("no access token, JWT or claim set is exposed in an error", async () => {
	const db = freshDb()
	linkedWorkspace(db)
	const token = mintToken({ aud: "api://some-other-api" })
	const error = await expectStatus(provider(db).verify(token), 401)
	assert.equal(error.message, "Authentication failed.")
	assert.ok(!error.message.includes(token))
	assert.ok(!JSON.stringify(error.message).includes("eyJ"))
})

/* ============================= AUTHORIZATION ============================== */

test("role, department and clearance come from Neon and change immediately", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const before = await provider(db).verify(mintToken())
	assert.equal(buildAccessScope(db, before!).isAdmin, false)

	// Promotion happens in Neon, not in the token: the same token now resolves
	// to an administrator.
	db.run(`UPDATE users SET role_key = ? WHERE id = ?`, "ADMIN", workspace.employee.id)
	const after = await provider(db).verify(mintToken())
	assert.equal(after!.roleKey, "ADMIN")
	assert.equal(buildAccessScope(db, after!).isAdmin, true)
})

/* ============================ SEARCH / BLOB =============================== */

test("the AccessScope handed to retrieval comes from the validated identity + Neon", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const principal = await provider(db).verify(mintToken())
	const scope = buildAccessScope(db, principal!)
	assert.equal(scope.tenantId, workspace.tenant.id)
	assert.equal(scope.userId, workspace.employee.id)
	assert.equal(scope.roleKey, "EMPLOYEE")
	// Phase 4 security filter input: an employee cannot read confidential HR.
	const confidentialHr = {
		tenantId: workspace.tenant.id,
		documentId: "doc_hr",
		department: "Human Resources",
		classification: "confidential" as const,
		allowedRoles: [],
		allowedUsers: [],
	}
	assert.equal(decideDocumentAccess(scope, confidentialHr).allowed, false)
	// …and cannot read another tenant's document at all.
	assert.equal(decideDocumentAccess(scope, { ...confidentialHr, tenantId: "ten_other", classification: "public" }).allowed, false)
})

test("blob access is gated by the same Neon-resolved document authorization", async () => {
	const db = freshDb()
	const workspace = linkedWorkspace(db)
	const principal = await provider(db).verify(mintToken())
	const scope = buildAccessScope(db, principal!)
	const opsInternal = {
		tenantId: workspace.tenant.id,
		documentId: "doc_ops",
		department: "Operations",
		classification: "internal" as const,
		allowedRoles: [],
		allowedUsers: [],
	}
	assert.equal(decideDocumentAccess(scope, opsInternal).allowed, true)
	assert.equal(decideDocumentAccess(scope, { ...opsInternal, allowedRoles: ["ADMIN"] }).allowed, false)
})

/* ============================== LOCAL MODE ================================ */

test("LOCAL/DEMO mode still works with no Entra configuration at all", async () => {
	const db = freshDb()
	const workspace = makeWorkspace(db, {
		name: "Local Demo",
		users: [{ name: "Demo User", email: "demo@local.example", roleKey: "EMPLOYEE", department: "Operations" }],
	})
	const demo = new DemoAuthProvider(db, "local-dev-only-change-me")
	const session = await demo.createSession({ tenantId: workspace.tenant.id, email: "demo@local.example" })
	const principal = await demo.verify(session.token)
	assert.equal(principal?.authMode, "demo")
	assert.equal(principal?.tenantId, workspace.tenant.id)
	const health = await demo.healthCheck()
	assert.equal(health.ok, true)
})

test("the provider is chosen by AUTH_MODE alone", () => {
	const db = freshDb()
	withEnv({}, () => {
		assert.equal(createAuthProvider(db).mode, "demo")
	})
	// Entra variables present but AUTH_MODE=demo: still demo.
	withEnv({ ...VALID_ENTRA_ENV, AUTH_MODE: "demo", DATABASE_URL: "" }, () => {
		assert.equal(createAuthProvider(db).mode, "demo")
	})
	withEnv(VALID_ENTRA_ENV, () => {
		const auth = createAuthProvider(db, async () => jwks())
		assert.equal(auth.mode, "entra")
		assert.equal(auth.isProduction, true)
	})
})

test("the Entra health check performs no network probe", async () => {
	const db = freshDb()
	const health = await provider(db).healthCheck()
	assert.equal(health.ok, true)
	assert.match(health.detail, /no network probe/)
})
