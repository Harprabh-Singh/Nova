/**
 * NOVA configuration.
 *
 * Rules enforced here:
 *  - LOCAL is the default for every provider.
 *  - Azure is NEVER auto-detected from the presence of credentials.
 *    A human must set AI_MODE / KNOWLEDGE_MODE / AUTH_MODE / ACTION_MODE.
 *  - No Azure value is read unless the matching mode was manually set.
 */
import fs from "node:fs"
import path from "node:path"

export type AiMode = "local" | "azure"
export type KnowledgeMode = "local" | "azure"
export type AuthMode = "demo" | "entra"
export type ActionMode = "local" | "azure"
export type VectorStoreMode = "local" | "azure_search"
export type StorageModeName = "local" | "azure_blob"

let loaded = false

/** Minimal dotenv loader (no dependency). Existing process env always wins. */
export function loadEnv(cwd = process.cwd()): void {
	if (loaded) return
	loaded = true
	const file = path.join(cwd, ".env")
	if (!fs.existsSync(file)) return
	for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) continue
		const eq = line.indexOf("=")
		if (eq === -1) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			// Quoted values are taken literally, including any '#'.
			value = value.slice(1, -1)
		} else {
			// Strip a trailing inline comment from unquoted values, so
			//   FOUNDRY_PROJECT=nova-foundry   # the Foundry project
			// parses as exactly "nova-foundry". Only ' #' (whitespace then hash)
			// counts, so keys and URLs containing '#' survive intact.
			const comment = value.search(/\s#/)
			if (comment !== -1) value = value.slice(0, comment).trim()
		}
		// Values are never transformed in case: FOUNDRY_PROJECT must stay
		// lowercase "nova-foundry", never "NOVA-Foundry".
		if (process.env[key] === undefined) process.env[key] = value
	}
}

function str(key: string, fallback = ""): string {
	const v = process.env[key]
	return v === undefined || v === "" ? fallback : v
}

/** Reads the first key that is present and non-empty. */
function firstStr(keys: string[], fallback = ""): string {
	for (const key of keys) {
		const value = str(key)
		if (value) return value
	}
	return fallback
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The single scope name NOVA's own API requires on a delegated access token. */
export const ENTRA_REQUIRED_SCOPE = "access_as_user"

export type EntraConfig = {
	tenantId: string
	clientId: string
	/** Application ID URI, e.g. api://<clientId>. This is the API audience. */
	apiIdUri: string
	/** Full delegated scope, e.g. api://<clientId>/access_as_user. */
	apiScope: string
	/** Scope name only (access_as_user), which is what appears in the `scp` claim. */
	requiredScope: string
	authority: string
	redirectUri: string
	postLogoutRedirectUri: string
	/** Accepted `aud` values for a NOVA API access token. */
	audiences: string[]
	/** Accepted `iss` values (v2.0 and v1.0 issuer formats for the same tenant). */
	issuers: string[]
	jwksCacheMs: number
	clockSkewSeconds: number
	/**
	 * First-time Entra users: when false (default) an unmapped identity is
	 * denied (403) until an administrator links it. When true a PENDING,
	 * privilege-free user record is created in the configured tenant.
	 */
	autoProvision: boolean
	autoProvisionTenantId: string
	autoProvisionRoleKey: string
	autoProvisionDepartment: string
}

/** Booleans are explicit: only "true"/"1" and "false"/"0" are accepted. */
function bool(key: string, fallback: boolean): boolean {
	const raw = str(key).toLowerCase()
	if (raw === "") return fallback
	if (raw === "true" || raw === "1" || raw === "yes") return true
	if (raw === "false" || raw === "0" || raw === "no") return false
	throw new ConfigError(`${key}="${process.env[key]}" is not a boolean. Allowed values: true | false`)
}

function num(key: string, fallback: number): number {
	const v = Number(process.env[key])
	return Number.isFinite(v) && process.env[key] !== "" ? v : fallback
}

/** Configuration is refused rather than silently corrected. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ConfigError"
	}
}

/**
 * Entra configuration. These are public client-application settings, not
 * secrets: they are safe in .env.example, in documentation and in the
 * browser. NOVA's Entra app is a PUBLIC client (SPA + PKCE) and has no client
 * secret, so none is ever read here.
 *
 * Legacy AZURE_TENANT_ID / AZURE_CLIENT_ID are still accepted as aliases so
 * pre-Phase-6 environments keep working.
 */
function buildEntraConfig(authMode: AuthMode): EntraConfig {
	const tenantId = firstStr(["ENTRA_TENANT_ID", "AZURE_TENANT_ID"])
	const clientId = firstStr(["ENTRA_CLIENT_ID", "AZURE_CLIENT_ID"])
	const apiIdUri = firstStr(["ENTRA_API_ID_URI", "ENTRA_AUDIENCE"], clientId ? `api://${clientId}` : "")
	const apiScope = str("ENTRA_API_SCOPE", apiIdUri ? `${apiIdUri}/${ENTRA_REQUIRED_SCOPE}` : "")
	const authority = str("ENTRA_AUTHORITY", tenantId ? `https://login.microsoftonline.com/${tenantId}` : "")
	const redirectUri = str("ENTRA_REDIRECT_URI")
	const requiredScope = apiScope.includes("/") ? apiScope.slice(apiScope.lastIndexOf("/") + 1) : ENTRA_REQUIRED_SCOPE

	const entra: EntraConfig = {
		tenantId,
		clientId,
		apiIdUri,
		apiScope,
		requiredScope,
		authority: authority.replace(/\/+$/, ""),
		redirectUri,
		postLogoutRedirectUri: str("ENTRA_POST_LOGOUT_REDIRECT_URI", redirectUri),
		// An access token for api://<clientId> carries either the Application ID
		// URI or the bare client id as `aud`, depending on the token version.
		audiences: [apiIdUri, clientId].filter(Boolean),
		issuers: tenantId
			? [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`]
			: [],
		jwksCacheMs: num("ENTRA_JWKS_CACHE_MS", 60 * 60 * 1000),
		clockSkewSeconds: num("ENTRA_CLOCK_SKEW_SECONDS", 60),
		autoProvision: bool("ENTRA_AUTO_PROVISION", false),
		autoProvisionTenantId: str("ENTRA_AUTO_PROVISION_TENANT_ID"),
		autoProvisionRoleKey: str("ENTRA_AUTO_PROVISION_ROLE_KEY", "PENDING"),
		autoProvisionDepartment: str("ENTRA_AUTO_PROVISION_DEPARTMENT", "Unassigned"),
	}

	if (authMode !== "entra") return entra

	/* AUTH_MODE=entra fails CLEARLY rather than falling back to demo auth. */
	const missing: string[] = []
	if (!entra.tenantId) missing.push("ENTRA_TENANT_ID")
	if (!entra.clientId) missing.push("ENTRA_CLIENT_ID")
	if (!entra.apiIdUri) missing.push("ENTRA_API_ID_URI")
	if (!entra.apiScope) missing.push("ENTRA_API_SCOPE")
	if (!entra.authority) missing.push("ENTRA_AUTHORITY")
	if (!entra.redirectUri) missing.push("ENTRA_REDIRECT_URI")
	if (missing.length) {
		throw new ConfigError(
			`AUTH_MODE=entra requires ${missing.join(", ")}. There is no fallback to demo authentication. See docs/azure-integration.md`,
		)
	}
	if (!GUID.test(entra.tenantId)) {
		throw new ConfigError(`ENTRA_TENANT_ID="${entra.tenantId}" is not a valid directory (tenant) GUID.`)
	}
	if (!GUID.test(entra.clientId)) {
		throw new ConfigError(`ENTRA_CLIENT_ID="${entra.clientId}" is not a valid application (client) GUID.`)
	}
	// Single-tenant by design: /common, /organizations and /consumers would let
	// identities from other directories reach the sign-in page.
	const expectedAuthority = `https://login.microsoftonline.com/${entra.tenantId}`
	if (entra.authority !== expectedAuthority) {
		throw new ConfigError(
			`ENTRA_AUTHORITY must be exactly ${expectedAuthority} for this single-tenant application ` +
				"(common / organizations / consumers are not accepted).",
		)
	}
	if (!entra.apiScope.startsWith(`${entra.apiIdUri}/`)) {
		throw new ConfigError(
			`ENTRA_API_SCOPE must start with "${entra.apiIdUri}/" (for example ${entra.apiIdUri}/${ENTRA_REQUIRED_SCOPE}).`,
		)
	}
	if (entra.requiredScope !== ENTRA_REQUIRED_SCOPE) {
		throw new ConfigError(`ENTRA_API_SCOPE must grant the "${ENTRA_REQUIRED_SCOPE}" delegated scope.`)
	}
	try {
		const url = new URL(entra.redirectUri)
		if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
			throw new ConfigError("ENTRA_REDIRECT_URI must use https outside localhost.")
		}
	} catch (error) {
		if (error instanceof ConfigError) throw error
		throw new ConfigError(`ENTRA_REDIRECT_URI="${entra.redirectUri}" is not a valid absolute URL.`)
	}
	// The SPA is a public client. A secret must never exist for it.
	if (str("ENTRA_CLIENT_SECRET") || str("AZURE_CLIENT_SECRET")) {
		throw new ConfigError(
			"AUTH_MODE=entra uses Authorization Code + PKCE with a PUBLIC client: remove ENTRA_CLIENT_SECRET / AZURE_CLIENT_SECRET.",
		)
	}
	if (entra.autoProvision && !entra.autoProvisionTenantId) {
		throw new ConfigError(
			"ENTRA_AUTO_PROVISION=true requires ENTRA_AUTO_PROVISION_TENANT_ID (the NOVA tenant pending users land in).",
		)
	}
	return entra
}

/** The port the browser must reach for the registered redirect URI to work. */
function redirectPort(redirectUri: string): number | null {
	try {
		const url = new URL(redirectUri)
		if (url.port) return Number(url.port)
		return url.protocol === "https:" ? 443 : 80
	} catch {
		return null
	}
}

/**
 * Read an enum-valued variable.
 *
 * An unset/empty value takes the fallback. A value that is set but not in the
 * allowed list is a hard error: silently falling back to "local" would make an
 * operator believe Azure is on when it is not (e.g. the historical
 * `VECTOR_STORE=azure` typo, where the only supported Azure value is
 * `azure_search`).
 */
function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	const raw = str(key)
	if (raw === "") return fallback
	const v = raw.toLowerCase() as T
	if (!allowed.includes(v)) {
		throw new ConfigError(`${key}="${raw}" is not supported. Allowed values: ${allowed.join(" | ")}`)
	}
	return v
}

export type NovaConfig = ReturnType<typeof buildConfig>

function buildConfig() {
	loadEnv()

	const aiMode = oneOf<AiMode>("AI_MODE", ["local", "azure"], "local")
	const knowledgeMode = oneOf<KnowledgeMode>("KNOWLEDGE_MODE", ["local", "azure"], "local")
	const authMode = oneOf<AuthMode>("AUTH_MODE", ["demo", "entra"], "demo")
	const actionMode = oneOf<ActionMode>("ACTION_MODE", ["local", "azure"], "local")
	const vectorStore = oneOf<VectorStoreMode>("VECTOR_STORE", ["local", "azure_search"], "local")
	/**
	 * Phase 5. Document FILES live either on the local filesystem or in Azure Blob
	 * Storage. Like every other provider the mode is chosen by a human; the
	 * presence of a connection string never switches it on by itself.
	 */
	const storageMode = oneOf<StorageModeName>("STORAGE_MODE", ["local", "azure_blob"], "local")

	const dbUrl = str("DATABASE_URL", "file:./data/nova.db")
	const isPostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://")

	/**
	 * APP_MODE is NOT an input. The application mode is derived from the five
	 * provider modes below, so a stray `APP_MODE=azure` must never look
	 * authoritative. If it is present it is validated against the derived value
	 * and rejected when it disagrees.
	 */
	const declaredAppMode = str("APP_MODE").toLowerCase()

	const anyAzure =
		aiMode === "azure" ||
		knowledgeMode === "azure" ||
		authMode === "entra" ||
		actionMode === "azure" ||
		vectorStore === "azure_search" ||
		storageMode === "azure_blob"

	if (anyAzure && !process.env.DATABASE_URL) {
		throw new ConfigError("DATABASE_URL is required in production/Azure mode.")
	}
	if (anyAzure && !isPostgres) {
		throw new ConfigError("DATABASE_URL must be a PostgreSQL connection string in production/Azure mode; SQLite fallback is disabled.")
	}

	if (vectorStore === "azure_search") {
		if (!process.env.AZURE_SEARCH_ENDPOINT) {
			throw new ConfigError("VECTOR_STORE=azure_search requires AZURE_SEARCH_ENDPOINT.")
		}
		if (!process.env.AZURE_SEARCH_ADMIN_KEY) {
			throw new ConfigError("VECTOR_STORE=azure_search requires AZURE_SEARCH_ADMIN_KEY (supplied through the environment only).")
		}
	}

	/**
	 * Azure Blob storage fails CLEARLY rather than falling back to local disk:
	 * a production deployment must never silently write documents next to the
	 * process. Only presence is checked here (no remote call, no key parsing
	 * beyond structure), so configuration validation stays zero-cost.
	 */
	if (storageMode === "azure_blob") {
		if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
			throw new ConfigError(
				"STORAGE_MODE=azure_blob requires AZURE_STORAGE_CONNECTION_STRING (supplied through the environment only).",
			)
		}
		if (!process.env.AZURE_STORAGE_CONTAINER) {
			throw new ConfigError("STORAGE_MODE=azure_blob requires AZURE_STORAGE_CONTAINER (for example: documents).")
		}
	}

	const derivedAppMode = anyAzure ? ("azure" as const) : ("local" as const)
	if (declaredAppMode && declaredAppMode !== derivedAppMode) {
		throw new ConfigError(
			`APP_MODE="${declaredAppMode}" contradicts the provider modes, which resolve to "${derivedAppMode}". ` +
				"APP_MODE is derived, not configurable: remove it and set AI_MODE / KNOWLEDGE_MODE / AUTH_MODE / " +
				"ACTION_MODE / VECTOR_STORE instead.",
		)
	}

	/**
	 * Phase 6. Entra settings are validated only when AUTH_MODE=entra, and the
	 * validation runs AFTER the database checks so the most fundamental
	 * misconfiguration is still reported first.
	 */
	const entra = buildEntraConfig(authMode)

	/**
	 * Phase 8. ACTION_MODE=azure means governed enterprise actions are executed
	 * by the NOVA Actions Azure Function app. There is NO fallback to the local
	 * mock: a deployment that says "azure" and quietly simulated the write would
	 * be worse than one that refused to start, because a person would be told
	 * their ticket exists when it does not.
	 *
	 * AZURE_ACTION_FUNCTION_KEY is optional so the app can be fronted by
	 * Entra-authenticated APIM or a private endpoint instead of a function key,
	 * but the URL is mandatory and must be https (a function key travelling over
	 * plain http is a leaked credential).
	 */
	if (actionMode === "azure") {
		const functionUrl = str("AZURE_ACTION_FUNCTION_URL")
		if (!functionUrl) {
			throw new ConfigError(
				"ACTION_MODE=azure requires AZURE_ACTION_FUNCTION_URL (the NOVA Actions Function app base URL, " +
					"for example https://nova-actions.azurewebsites.net). There is no fallback to the local mock executor. " +
					"See docs/governed-actions.md",
			)
		}
		let parsed: URL
		try {
			parsed = new URL(functionUrl)
		} catch {
			throw new ConfigError(`AZURE_ACTION_FUNCTION_URL="${functionUrl}" is not a valid absolute URL.`)
		}
		if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
			throw new ConfigError("AZURE_ACTION_FUNCTION_URL must use https outside localhost.")
		}
	}

	/**
	 * Redirect origin determinism. Microsoft Entra only accepts the exact
	 * redirect URI registered on the application, so in Entra mode the server
	 * binds the port of that URI and FAILS rather than silently moving to an
	 * unregistered port. Demo/local mode keeps its port fallback.
	 */
	const explicitPort = str("PORT") !== "" ? num("PORT", 4317) : null
	const entraPort = authMode === "entra" ? redirectPort(entra.redirectUri) : null
	if (authMode === "entra" && entraPort === null) {
		throw new ConfigError(`ENTRA_REDIRECT_URI="${entra.redirectUri}" does not resolve to a port NOVA can bind.`)
	}
	if (authMode === "entra" && explicitPort !== null && entraPort !== null && explicitPort !== entraPort) {
		throw new ConfigError(
			`PORT=${explicitPort} contradicts ENTRA_REDIRECT_URI=${entra.redirectUri} (port ${entraPort}). ` +
				"In Entra mode NOVA must serve the exact registered redirect origin.",
		)
	}
	const port = entraPort ?? explicitPort ?? 4317

	return {
		/** Derived from the provider modes. Never read from APP_MODE. */
		appMode: derivedAppMode,
		modes: { aiMode, knowledgeMode, authMode, actionMode, vectorStore, storageMode },
		/** True only when every provider is local/demo. Drives the LOCAL DEMO MODE badge. */
		isFullyLocal: !anyAzure,
		server: {
			port,
			/**
			 * Automatic "port is busy, try the next one" behaviour. Kept for
			 * demo/local mode; disabled in Entra mode, where binding an
			 * unregistered origin would break authentication confusingly.
			 */
			allowPortFallback: authMode !== "entra",
			/** Loopback by default: NOVA is not exposed on the network unless asked. */
			host: str("HOST", "127.0.0.1"),
			logLevel: str("LOG_LEVEL", "info"),
			/**
			 * HTTPS. Off by default: locally `localhost` is already a secure
			 * context, and in a real deployment TLS is normally terminated by the
			 * platform or a proxy in front of NOVA. Set HTTPS_ENABLED=true only
			 * when NOVA itself must terminate TLS, and supply a real certificate
			 * through TLS_CERT_FILE / TLS_KEY_FILE.
			 */
			https: bool("HTTPS_ENABLED", false),
			tls: {
				certFile: str("TLS_CERT_FILE", ""),
				keyFile: str("TLS_KEY_FILE", ""),
			},
		},
		database: { url: dbUrl, kind: isPostgres ? ("postgres" as const) : ("sqlite" as const) },
		paths: {
			dbFile: dbUrl.startsWith("file:") ? dbUrl.slice("file:".length) : dbUrl,
			storageDir: str("STORAGE_DIR", "./data/storage"),
			seedKnowledgeDir: str("SEED_KNOWLEDGE_DIR", "./knowledge"),
			webDist: str("WEB_DIST", "./frontend/dist"),
		},
		documents: {
			/**
			 * Hard upload ceiling, enforced before a single byte reaches storage.
			 * Configurable so an operator never has to patch code to change it.
			 */
			maxBytes: num("MAX_DOCUMENT_SIZE_BYTES", 15 * 1024 * 1024),
		},
		demoAuth: { sessionSecret: str("DEMO_SESSION_SECRET", "local-dev-only-change-me") },
		/**
		 * Microsoft Entra ID (Phase 6). Public application configuration only:
		 * client id, tenant id, authority, API scope and redirect URI. There is
		 * no client secret, and no NOVA authorization data lives here - Neon
		 * remains the source of truth for tenant, role, department and
		 * classification.
		 */
		entra,
		localLlm: {
			baseUrl: str("LOCAL_LLM_BASE_URL"),
			model: str("LOCAL_LLM_MODEL", "qwen2.5:7b-instruct"),
			apiKey: str("LOCAL_LLM_API_KEY"),
			timeoutMs: num("LOCAL_LLM_TIMEOUT_MS", 60_000),
		},
		embeddings: {
			baseUrl: str("LOCAL_EMBEDDING_BASE_URL"),
			model: str("LOCAL_EMBEDDING_MODEL", "nova-hashed-lexical-v1"),
			dim: num("EMBEDDING_DIM", 384),
		},
		retrieval: {
			topK: num("RETRIEVAL_TOP_K", 8),
			candidates: num("RETRIEVAL_CANDIDATES", 40),
			vectorWeight: num("HYBRID_VECTOR_WEIGHT", 0.6),
			keywordWeight: num("HYBRID_KEYWORD_WEIGHT", 0.4),
			chunkChars: num("CHUNK_TARGET_CHARS", 1100),
			chunkOverlap: num("CHUNK_OVERLAP_CHARS", 150),
		},
		/** Azure settings are only materialised when a mode explicitly asks for Azure. */
		azure: anyAzure
			? {
					foundry: {
						/**
						 * Foundry PROJECT endpoint:
						 *   https://<resource>.services.ai.azure.com/api/projects/<project>
						 * The OpenAI-compatible routes hang off /openai/v1; the providers
						 * append that themselves. No api-version is used on the v1 route.
						 */
						endpoint: str("FOUNDRY_ENDPOINT").replace(/\/+$/, ""),
						project: str("FOUNDRY_PROJECT"),
						agentId: str("FOUNDRY_AGENT_ID"),
						deployment: str("FOUNDRY_MODEL_DEPLOYMENT"),
						embeddingDeployment: str("AZURE_EMBEDDING_DEPLOYMENT"),
					},
					search: {
						endpoint: str("AZURE_SEARCH_ENDPOINT").replace(/\/+$/, ""),
						index: str("AZURE_SEARCH_INDEX", "nova-knowledge"),
						/** Stable data-plane version; preview versions are not used. */
						apiVersion: str("AZURE_SEARCH_API_VERSION", "2024-07-01"),
						/** SECRET. Never logged, never returned by an API, never in .env.example. */
						adminKey: str("AZURE_SEARCH_ADMIN_KEY"),
					},
					storage: {
						account: str("AZURE_STORAGE_ACCOUNT"),
						container: str("AZURE_STORAGE_CONTAINER"),
						/** SECRET. Never logged, never returned by an API, never in .env.example. */
						connectionString: str("AZURE_STORAGE_CONNECTION_STRING"),
					},
					entra: {
						// Mirror of the Phase 6 block, kept so /api/health and any
						// pre-Phase-6 caller keep reading the same shape.
						tenantId: entra.tenantId,
						clientId: entra.clientId,
						clientSecret: "",
						audience: entra.apiIdUri,
					},
					action: {
						/** Legacy Phase 4 incident workflow (Logic App / generic endpoint). */
						workflowUrl: str("AZURE_ACTION_WORKFLOW_URL"),
						apiKey: str("AZURE_ACTION_API_KEY"),
						/**
						 * Phase 8. Base URL of the NOVA Actions Function app. Routes are
						 * appended by the executor (/api/actions/<route>), so this value is
						 * the app origin, not a single route.
						 */
						functionUrl: str("AZURE_ACTION_FUNCTION_URL").replace(/\/+$/, ""),
						/** SECRET. Never logged, never returned by an API, never in .env.example. */
						functionKey: str("AZURE_ACTION_FUNCTION_KEY"),
						functionTimeoutMs: num("AZURE_ACTION_FUNCTION_TIMEOUT_MS", 20_000),
					},
					apiKey: str("AZURE_API_KEY"),
					/**
					 * Optional pre-acquired Entra access token (scope
					 * https://ai.azure.com/.default). Preferred over a static key in
					 * production; when present it wins over AZURE_API_KEY.
					 */
					accessToken: str("AZURE_ACCESS_TOKEN"),
				}
			: null,
	}
}

let cached: NovaConfig | null = null

export function getConfig(): NovaConfig {
	if (!cached) cached = buildConfig()
	return cached
}

/** Test helper: force a fresh read of process.env. */
export function resetConfigCache(): void {
	cached = null
}
