/**
 * Configuration and Azure-readiness suite.
 *
 * Covers the two failure modes that previously let NOVA lie about its state:
 *
 *   1. a mode variable set to an unsupported value silently falling back to
 *      local (the `VECTOR_STORE=azure` typo), and
 *   2. a badge claiming more than the evidence supports.
 *
 * Nothing here touches the network: `computeAzureReadiness` is pure (it reads
 * modes, provider identity and local settings only), and the config tests only
 * manipulate process.env. Since v10 there is no live probe anywhere in the
 * health path, so the strongest badge is AZURE CONFIGURED - never CONNECTED.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { ConfigError, getConfig, resetConfigCache } from "../backend/src/config/index.ts"
import {
	componentSummary,
	computeAzureReadiness,
	type AzureConfigSnapshot,
	type ReadinessModes,
	type ReadinessProviders,
} from "../backend/src/api/health.ts"

const MODE_KEYS = [
	"APP_MODE",
	"AI_MODE",
	"KNOWLEDGE_MODE",
	"AUTH_MODE",
	"ACTION_MODE",
	"VECTOR_STORE",
	"DATABASE_URL",
	"AZURE_SEARCH_ENDPOINT",
	"AZURE_SEARCH_ADMIN_KEY",
] as const

/** Run `fn` with an exact mode environment, then restore the previous one. */
function withEnv<T>(env: Partial<Record<(typeof MODE_KEYS)[number], string>>, fn: () => T): T {
	const previous = new Map<string, string | undefined>()
	for (const key of MODE_KEYS) {
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

/* ------------------------------ configuration ----------------------------- */

test("an unsupported VECTOR_STORE value is rejected instead of falling back to local", () => {
	withEnv({ VECTOR_STORE: "azure" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => {
			assert.ok(error instanceof ConfigError)
			assert.match((error as Error).message, /VECTOR_STORE/)
			assert.match((error as Error).message, /azure_search/)
			return true
		})
	})
})

/** Placeholder credentials for configuration tests. Never a real key. */
const SEARCH_ENV = {
	AZURE_SEARCH_ENDPOINT: "https://example.search.windows.net",
	AZURE_SEARCH_ADMIN_KEY: "test-only-not-a-real-key",
} as const

test("azure_search is the supported Azure vector store value", () => {
	withEnv({ VECTOR_STORE: "azure_search", DATABASE_URL: "postgresql://test/neon", ...SEARCH_ENV }, () => {
		const config = getConfig()
		assert.equal(config.modes.vectorStore, "azure_search")
		assert.equal(config.isFullyLocal, false)
		assert.equal(config.appMode, "azure")
	})
})

test("an unsupported AI_MODE value is rejected", () => {
	withEnv({ AI_MODE: "cloud" }, () => {
		assert.throws(() => getConfig(), ConfigError)
	})
})

test("APP_MODE that contradicts the provider modes is rejected", () => {
	withEnv({ APP_MODE: "azure" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => {
			assert.ok(error instanceof ConfigError)
			assert.match((error as Error).message, /APP_MODE/)
			assert.match((error as Error).message, /derived/)
			return true
		})
	})
})

test("appMode is derived from the provider modes, not from APP_MODE", () => {
	withEnv({}, () => {
		assert.equal(getConfig().appMode, "local")
	})
	withEnv({ AI_MODE: "azure", DATABASE_URL: "postgresql://test/neon" }, () => {
		const config = getConfig()
		assert.equal(config.appMode, "azure")
		assert.equal(config.isFullyLocal, false)
	})
})

/* --------------------------- database selection --------------------------- */

test("local/demo mode defaults to the local SQLite file", () => {
	withEnv({}, () => {
		const config = getConfig()
		assert.equal(config.database.kind, "sqlite")
		assert.equal(config.database.url, "file:./data/nova.db")
		assert.equal(config.paths.dbFile, "./data/nova.db")
	})
})

test("production/Azure mode refuses to start without DATABASE_URL", () => {
	for (const mode of [{ AI_MODE: "azure" }, { KNOWLEDGE_MODE: "azure" }, { AUTH_MODE: "entra" }, { ACTION_MODE: "azure" }, { VECTOR_STORE: "azure_search", ...SEARCH_ENV }]) {
		withEnv(mode, () => {
			assert.throws(
				() => getConfig(),
				(error: unknown) => {
					assert.ok(error instanceof ConfigError)
					assert.match((error as Error).message, /DATABASE_URL is required/)
					return true
				},
				`expected ${JSON.stringify(mode)} to require DATABASE_URL`,
			)
		})
	}
})

test("production/Azure mode refuses a non-PostgreSQL DATABASE_URL instead of falling back to SQLite", () => {
	for (const url of ["file:./data/nova.db", "./data/nova.db", ":memory:", "mysql://host/db"]) {
		withEnv({ AI_MODE: "azure", DATABASE_URL: url }, () => {
			assert.throws(
				() => getConfig(),
				(error: unknown) => {
					assert.ok(error instanceof ConfigError)
					assert.match((error as Error).message, /PostgreSQL/)
					assert.match((error as Error).message, /fallback is disabled/)
					return true
				},
				`expected ${url} to be rejected in Azure mode`,
			)
		})
	}
})

test("a PostgreSQL DATABASE_URL selects the postgres driver", () => {
	for (const url of ["postgres://u:p@host/db", "postgresql://u:p@host/db?sslmode=require"]) {
		withEnv({ AI_MODE: "azure", DATABASE_URL: url }, () => {
			const config = getConfig()
			assert.equal(config.database.kind, "postgres")
			assert.equal(config.database.url, url)
		})
	}
})

/* --------------------------- azure search config -------------------------- */

test("VECTOR_STORE=azure_search requires the Search endpoint and admin key", () => {
	withEnv({ VECTOR_STORE: "azure_search", DATABASE_URL: "postgresql://test/neon" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => {
			assert.ok(error instanceof ConfigError)
			assert.match((error as Error).message, /AZURE_SEARCH_ENDPOINT/)
			return true
		})
	})
	withEnv({ VECTOR_STORE: "azure_search", DATABASE_URL: "postgresql://test/neon", AZURE_SEARCH_ENDPOINT: SEARCH_ENV.AZURE_SEARCH_ENDPOINT }, () => {
		assert.throws(() => getConfig(), (error: unknown) => {
			assert.ok(error instanceof ConfigError)
			assert.match((error as Error).message, /AZURE_SEARCH_ADMIN_KEY/)
			return true
		})
	})
})

test("the search index name defaults to nova-knowledge", () => {
	withEnv({ VECTOR_STORE: "azure_search", DATABASE_URL: "postgresql://test/neon", ...SEARCH_ENV }, () => {
		const config = getConfig()
		assert.equal(config.azure?.search.index, "nova-knowledge")
		assert.equal(config.azure?.search.apiVersion, "2024-07-01", "must stay on a stable, non-preview API version")
	})
})

test("local mode never materialises Azure Search configuration", () => {
	withEnv({}, () => {
		const config = getConfig()
		assert.equal(config.azure, null, "no Azure block at all in fully local mode")
		assert.equal(config.modes.vectorStore, "local")
	})
})

/* ------------------------------- readiness -------------------------------- */

const LOCAL_MODES: ReadinessModes = {
	aiMode: "local",
	knowledgeMode: "local",
	authMode: "demo",
	actionMode: "local",
	vectorStore: "local",
	storageMode: "local",
}

const AZURE_MODES: ReadinessModes = {
	aiMode: "azure",
	knowledgeMode: "azure",
	authMode: "entra",
	actionMode: "azure",
	vectorStore: "azure_search",
	storageMode: "azure_blob",
}

/** A complete, syntactically valid Azure settings snapshot. No real secrets. */
function azureSnapshot(overrides: Partial<NonNullable<AzureConfigSnapshot>> = {}): AzureConfigSnapshot {
	return {
		foundry: {
			endpoint: "https://example.services.ai.azure.com/api/projects/nova-foundry",
			deployment: "nova-chat",
			embeddingDeployment: "nova-embedding",
			hasCredential: true,
		},
		search: { endpoint: "https://example.search.windows.net", index: "nova-index", hasAdminKey: true },
		storage: { account: "novastorage", container: "documents", hasConnectionString: true },
		entra: { tenantId: "tenant", clientId: "client", audience: "api://nova" },
		action: { workflowUrl: "https://example.logic.azure.com/workflows/nova" },
		embeddingDim: 1536,
		...overrides,
	}
}

function providers(overrides: Partial<ReadinessProviders> = {}): ReadinessProviders {
	return {
		llm: { mode: "azure" },
		embeddings: { mode: "azure" },
		knowledge: { mode: "azure" },
		vectorStore: { mode: "azure_search" },
		auth: { mode: "entra" },
		actions: { mode: "azure" },
		storage: { mode: "azure_blob" },
		...overrides,
	}
}

function localProviders(): ReadinessProviders {
	return {
		llm: { mode: "local" },
		embeddings: { mode: "local" },
		knowledge: { mode: "local" },
		vectorStore: { mode: "local" },
		auth: { mode: "demo" },
		actions: { mode: "local" },
		storage: { mode: "local" },
	}
}

test("a fully local deployment reports LOCAL DEMO MODE", () => {
	const readiness = computeAzureReadiness(LOCAL_MODES, localProviders(), null)
	assert.equal(readiness.badge, "LOCAL DEMO MODE")
	assert.equal(readiness.status, "local")
	assert.equal(readiness.azureConfigured, false)
	assert.equal(readiness.partial, false)
	assert.deepEqual(readiness.azureComponents, [])
	assert.equal(readiness.components.llm.state, "local")
})

test("azure configuration with a local implementation loaded is misconfigured", () => {
	const readiness = computeAzureReadiness(
		AZURE_MODES,
		providers({ llm: { mode: "local" } }),
		azureSnapshot(),
	)
	assert.equal(readiness.badge, "AZURE CONFIGURED - INCOMPLETE")
	assert.equal(readiness.status, "configuration_incomplete")
	assert.equal(readiness.azureConfigured, false)
	assert.equal(readiness.components.llm.state, "misconfigured")
	assert.ok(readiness.incompleteComponents.includes("llm"))
})

test("a partial azure configuration is reported as partial", () => {
	const readiness = computeAzureReadiness(
		{ ...LOCAL_MODES, aiMode: "azure" },
		providers(),
		azureSnapshot(),
	)
	assert.equal(readiness.partial, true)
	assert.deepEqual(readiness.azureComponents, ["llm", "embeddings"])
	assert.equal(readiness.components.knowledge.state, "local")
	assert.equal(readiness.badge, "AZURE CONFIGURED")
})

test("a missing deployment name downgrades the component to incomplete", () => {
	const snapshot = azureSnapshot()
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), {
		...snapshot!,
		foundry: { ...snapshot!.foundry, embeddingDeployment: "" },
	})
	assert.equal(readiness.badge, "AZURE CONFIGURED - INCOMPLETE")
	assert.equal(readiness.components.embeddings.state, "incomplete")
	assert.deepEqual(readiness.incompleteComponents, ["embeddings"])
	assert.match(readiness.components.embeddings.detail ?? "", /AZURE_EMBEDDING_DEPLOYMENT/)
})

test("a missing credential downgrades foundry and embeddings", () => {
	const snapshot = azureSnapshot()
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), {
		...snapshot!,
		foundry: { ...snapshot!.foundry, hasCredential: false },
	})
	assert.equal(readiness.azureConfigured, false)
	assert.deepEqual(readiness.incompleteComponents, ["llm", "embeddings"])
})

test("an invalid embedding dimension is caught locally", () => {
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), azureSnapshot({ embeddingDim: 0 }))
	assert.equal(readiness.components.embeddings.state, "incomplete")
	assert.match(readiness.components.embeddings.detail ?? "", /EMBEDDING_DIM/)
})

test("a non-https endpoint is rejected syntactically, without a network call", () => {
	const snapshot = azureSnapshot()
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), {
		...snapshot!,
		foundry: { ...snapshot!.foundry, endpoint: "not-a-url" },
	})
	assert.equal(readiness.components.llm.state, "incomplete")
	assert.match(readiness.components.llm.detail ?? "", /FOUNDRY_ENDPOINT/)
})

test("AZURE CONFIGURED requires every selected component complete and correctly loaded", () => {
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), azureSnapshot())
	assert.equal(readiness.badge, "AZURE CONFIGURED")
	assert.equal(readiness.status, "configured")
	assert.equal(readiness.azureConfigured, true)
	assert.equal(readiness.partial, false)
	assert.equal(readiness.incompleteComponents.length, 0)
	// llm, embeddings, knowledge, vectorStore, storage, auth, actions
	assert.equal(readiness.azureComponents.length, 7)
	assert.ok(readiness.azureComponents.includes("storage"))
})

test("azure blob storage is reported incomplete when its settings are missing", () => {
	const snapshot = azureSnapshot()
	snapshot!.storage = { account: "", container: "", hasConnectionString: false }
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), snapshot)
	assert.equal(readiness.components.storage.state, "incomplete")
	assert.match(readiness.components.storage.detail ?? "", /AZURE_STORAGE_CONNECTION_STRING/)
	assert.match(readiness.components.storage.detail ?? "", /AZURE_STORAGE_CONTAINER/)
	assert.ok(readiness.incompleteComponents.includes("storage"))
})

test("local document storage alongside azure providers is reported as local, never as azure", () => {
	const readiness = computeAzureReadiness(
		{ ...AZURE_MODES, storageMode: "local" },
		providers({ storage: { mode: "local" } }),
		azureSnapshot(),
	)
	assert.equal(readiness.components.storage.state, "local")
	assert.ok(!readiness.azureComponents.includes("storage"))
	assert.equal(readiness.partial, true)
})

test("readiness never claims a live connection", () => {
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), azureSnapshot())
	const serialized = JSON.stringify(readiness)
	assert.doesNotMatch(serialized, /CONNECTED/)
	assert.doesNotMatch(serialized, /verified/i)
})

test("componentSummary never leaks more than configured / not_configured / local", () => {
	const status = (state: "configured" | "local" | "incomplete" | "misconfigured") => ({
		configured: state === "configured",
		implementation: "azure",
		state,
	})
	assert.equal(componentSummary(status("configured")), "configured")
	assert.equal(componentSummary(status("local")), "local")
	assert.equal(componentSummary(status("misconfigured")), "not_configured")
	assert.equal(componentSummary(status("incomplete")), "not_configured")
	assert.equal(componentSummary(undefined), "not_configured")
})
