/**
 * Provider-mode independence.
 *
 * NOVA selects each provider from its own environment variable. That is easy
 * to state and easy to break: one `anyAzure`-style shortcut in the wrong place
 * and a single local mode drags the rest of the stack down with it, or an
 * Azure-selected component starts reporting "incomplete" because an unrelated
 * component is local.
 *
 * The demo configuration makes that risk concrete. It is:
 *
 *   AI_MODE=azure  KNOWLEDGE_MODE=azure  AUTH_MODE=entra
 *   VECTOR_STORE=azure_search  STORAGE_MODE=azure_blob  DATABASE_URL=postgres…
 *   ACTION_MODE=local            <-- the ONLY local component
 *
 * i.e. the whole knowledge stack stays Azure-backed while only the governed
 * action executor is simulated. These tests pin that down so it cannot regress
 * silently, and they run entirely offline: every factory is constructed and
 * asked for its own identity, and no provider method is ever called, so no
 * Azure request is made and no model token is spent.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { getConfig, resetConfigCache, ConfigError } from "../backend/src/config/index.ts"
import { createMemoryDb } from "../backend/src/db/index.ts"
import { createLLMProvider } from "../backend/src/llm/index.ts"
import { createEmbeddingProvider } from "../backend/src/embeddings/index.ts"
import { createKnowledgeProvider, createVectorStore } from "../backend/src/knowledge/index.ts"
import { createStorageProvider } from "../backend/src/storage/index.ts"
import { createAuthProvider } from "../backend/src/auth/index.ts"
import { createActionProvider } from "../backend/src/actions/index.ts"
import { createActionExecutor } from "../backend/src/actions/governed/index.ts"
import { buildHealthPayload, computeAzureReadiness, azureConfigSnapshot } from "../backend/src/api/health.ts"

/* -------------------------------- fixtures -------------------------------- */

/** Syntactically valid, obviously fake. No value here is a real credential. */
const ENTRA_TENANT = "191223fe-a651-4b8c-a79d-8b368bba577d"
const ENTRA_CLIENT = "9bb0d161-2be5-4d0c-b5f5-8c54211c0d1d"
const NEON_URL = "postgresql://nova:not-a-real-password@ep-example.neon.tech/nova?sslmode=require"
const FAKE_STORAGE_CONNECTION =
	"DefaultEndpointsProtocol=https;AccountName=novastorage2376;AccountKey=ZmFrZS1rZXktZm9yLXRlc3Rz;EndpointSuffix=core.windows.net"

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
	"EMBEDDING_DIM",
	"FOUNDRY_ENDPOINT",
	"FOUNDRY_PROJECT",
	"FOUNDRY_MODEL_DEPLOYMENT",
	"AZURE_EMBEDDING_DEPLOYMENT",
	"AZURE_API_KEY",
	"AZURE_ACCESS_TOKEN",
	"AZURE_SEARCH_ENDPOINT",
	"AZURE_SEARCH_INDEX",
	"AZURE_SEARCH_ADMIN_KEY",
	"AZURE_STORAGE_ACCOUNT",
	"AZURE_STORAGE_CONTAINER",
	"AZURE_STORAGE_CONNECTION_STRING",
	"ENTRA_TENANT_ID",
	"ENTRA_CLIENT_ID",
	"ENTRA_API_ID_URI",
	"ENTRA_API_SCOPE",
	"ENTRA_AUTHORITY",
	"ENTRA_REDIRECT_URI",
	"ENTRA_AUTO_PROVISION",
	"ENTRA_CLIENT_SECRET",
	"AZURE_CLIENT_SECRET",
	"AZURE_ACTION_FUNCTION_URL",
	"AZURE_ACTION_FUNCTION_KEY",
	"AZURE_ACTION_WORKFLOW_URL",
	"AZURE_ACTION_API_KEY",
] as const

/** Exactly the demo configuration: everything Azure except the actions. */
function demoEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		AI_MODE: "azure",
		KNOWLEDGE_MODE: "azure",
		AUTH_MODE: "entra",
		VECTOR_STORE: "azure_search",
		STORAGE_MODE: "azure_blob",
		ACTION_MODE: "local",
		DATABASE_URL: NEON_URL,
		EMBEDDING_DIM: "384",
		FOUNDRY_ENDPOINT: "https://example.services.ai.azure.com/api/projects/nova-foundry",
		FOUNDRY_PROJECT: "nova-foundry",
		FOUNDRY_MODEL_DEPLOYMENT: "nova-chat",
		AZURE_EMBEDDING_DEPLOYMENT: "nova-embedding",
		AZURE_API_KEY: "test-only-not-a-real-key",
		AZURE_SEARCH_ENDPOINT: "https://nova-search.search.windows.net",
		AZURE_SEARCH_INDEX: "nova-knowledge",
		AZURE_SEARCH_ADMIN_KEY: "test-only-not-a-real-key",
		AZURE_STORAGE_ACCOUNT: "novastorage2376",
		AZURE_STORAGE_CONTAINER: "documents",
		AZURE_STORAGE_CONNECTION_STRING: FAKE_STORAGE_CONNECTION,
		ENTRA_TENANT_ID: ENTRA_TENANT,
		ENTRA_CLIENT_ID: ENTRA_CLIENT,
		ENTRA_API_ID_URI: `api://${ENTRA_CLIENT}`,
		ENTRA_API_SCOPE: `api://${ENTRA_CLIENT}/access_as_user`,
		ENTRA_AUTHORITY: `https://login.microsoftonline.com/${ENTRA_TENANT}`,
		ENTRA_REDIRECT_URI: "http://localhost:4317",
		ENTRA_AUTO_PROVISION: "false",
		...overrides,
	}
}

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

/**
 * Construct every provider and report only its own identity. No provider
 * method is invoked, so this performs zero remote calls.
 */
function buildProviders() {
	const db = createMemoryDb()
	const embeddings = createEmbeddingProvider()
	const vectorStore = createVectorStore(db)
	return {
		db,
		llm: createLLMProvider(),
		embeddings,
		vectorStore,
		knowledge: createKnowledgeProvider(vectorStore, embeddings),
		storage: createStorageProvider(),
		auth: createAuthProvider(db),
		/** Phase 4 incident provider - follows ACTION_MODE as well. */
		incidentActions: createActionProvider(db),
		/** Phase 8 governed executor. */
		executor: createActionExecutor(),
	}
}

/* ---------------------- the demo configuration resolves ------------------- */

test("the demo configuration is accepted and stays in Azure application mode", () => {
	withEnv(demoEnv(), () => {
		const config = getConfig()
		assert.equal(config.appMode, "azure")
		assert.equal(config.isFullyLocal, false, "a local action executor must not make the app 'fully local'")
		assert.deepEqual(config.modes, {
			aiMode: "azure",
			knowledgeMode: "azure",
			authMode: "entra",
			actionMode: "local",
			vectorStore: "azure_search",
			storageMode: "azure_blob",
		})
	})
})

test("ACTION_MODE=local loads the local mock executor and nothing else changes", () => {
	withEnv(demoEnv(), () => {
		const providers = buildProviders()
		// The ONLY local components.
		assert.equal(providers.executor.name, "local_mock")
		assert.equal(providers.executor.simulated, true, "a local action must be labelled simulated")
		assert.equal(providers.incidentActions.mode, "local")
		assert.equal(providers.incidentActions.simulated, true)
		// Everything else is the Azure implementation.
		assert.equal(providers.llm.mode, "azure")
		assert.equal(providers.llm.name, "AzureFoundryLLMProvider")
		assert.equal(providers.embeddings.mode, "azure")
		assert.equal(providers.embeddings.name, "AzureEmbeddingProvider")
		assert.equal(providers.vectorStore.mode, "azure_search")
		assert.equal(providers.vectorStore.name, "AzureVectorStore")
		assert.equal(providers.knowledge.mode, "azure")
		assert.equal(providers.knowledge.name, "AzureKnowledgeProvider")
		assert.equal(providers.storage.mode, "azure_blob")
		assert.equal(providers.auth.mode, "entra")
		assert.equal(providers.auth.name, "EntraAuthProvider")
	})
})

test("the database stays PostgreSQL and never falls back to SQLite", () => {
	withEnv(demoEnv(), () => {
		const config = getConfig()
		assert.equal(config.database.kind, "postgres")
		assert.equal(config.database.url, NEON_URL)
	})
	// A local action executor does not relax the PostgreSQL requirement.
	withEnv(demoEnv({ DATABASE_URL: "file:./data/nova.db" }), () => {
		assert.throws(
			() => getConfig(),
			(error: unknown) => {
				assert.ok(error instanceof ConfigError)
				assert.match((error as Error).message, /must be a PostgreSQL connection string/)
				return true
			},
		)
	})
})

test("switching ACTION_MODE between local and azure changes only the executor", () => {
	const local = withEnv(demoEnv(), () => {
		const providers = buildProviders()
		return {
			executor: providers.executor.name,
			others: [
				providers.llm.mode,
				providers.embeddings.mode,
				providers.vectorStore.mode,
				providers.knowledge.mode,
				providers.storage.mode,
				providers.auth.mode,
			],
		}
	})
	// NOTE: ACTION_MODE=azure currently needs BOTH endpoints, because the Phase 8
	// governed executor requires AZURE_ACTION_FUNCTION_URL while the Phase 4
	// incident ActionProvider still requires AZURE_ACTION_WORKFLOW_URL. Neither
	// is read in the demo configuration (ACTION_MODE=local); this test documents
	// the coupling rather than working around it.
	const azure = withEnv(
		demoEnv({
			ACTION_MODE: "azure",
			AZURE_ACTION_FUNCTION_URL: "https://nova-actions.azurewebsites.net",
			AZURE_ACTION_WORKFLOW_URL: "https://example.logic.azure.com/workflows/nova",
		}),
		() => {
			const providers = buildProviders()
			return {
				executor: providers.executor.name,
				others: [
					providers.llm.mode,
					providers.embeddings.mode,
					providers.vectorStore.mode,
					providers.knowledge.mode,
					providers.storage.mode,
					providers.auth.mode,
				],
			}
		},
	)
	assert.equal(local.executor, "local_mock")
	assert.equal(azure.executor, "azure_function")
	// Every other provider is byte-for-byte the same selection.
	assert.deepEqual(local.others, azure.others)
})

/* ------------------------- no Function app required ----------------------- */

test("local action mode requires no Function app configuration at all", () => {
	withEnv(demoEnv(), () => {
		const config = getConfig()
		// Unset, and nothing asks for them.
		assert.equal(config.azure?.action.functionUrl, "")
		assert.equal(config.azure?.action.functionKey, "")
		assert.equal(config.azure?.action.workflowUrl, "")
		assert.equal(createActionExecutor().name, "local_mock")
	})
})

test("a stale Function URL in the environment is ignored while ACTION_MODE=local", () => {
	withEnv(demoEnv({ AZURE_ACTION_FUNCTION_URL: "https://nova-actions.azurewebsites.net" }), () => {
		// Presence of a credential NEVER switches a provider on by itself.
		assert.equal(getConfig().modes.actionMode, "local")
		assert.equal(createActionExecutor().name, "local_mock")
		assert.equal(createActionExecutor().simulated, true)
	})
})

/* ----------------------- health stays honest and free --------------------- */

test("a local action executor does not make the health badge read INCOMPLETE", () => {
	withEnv(demoEnv(), () => {
		const config = getConfig()
		const providers = buildProviders()
		const readiness = computeAzureReadiness(
			config.modes,
			{
				llm: providers.llm,
				embeddings: providers.embeddings,
				knowledge: providers.knowledge,
				vectorStore: providers.vectorStore,
				auth: providers.auth,
				actions: providers.incidentActions,
				storage: providers.storage,
			},
			azureConfigSnapshot(config as never),
		)
		assert.equal(readiness.badge, "AZURE CONFIGURED")
		assert.deepEqual(readiness.incompleteComponents, [], "an intentionally local component must not be 'incomplete'")
		// Actions are reported as what they are: intentionally local.
		assert.equal(readiness.components.actions?.state, "local")
		assert.equal(readiness.components.actions?.configured, false)
		// The Azure-selected set excludes actions, and includes everything else.
		assert.deepEqual(readiness.azureComponents.sort(), [
			"auth",
			"embeddings",
			"knowledge",
			"llm",
			"storage",
			"vectorStore",
		])
	})
})

test("the health payload for the demo configuration still performs zero probes", () => {
	withEnv(demoEnv(), () => {
		const config = getConfig()
		const providers = buildProviders()
		const probes: string[] = []
		/** Any healthCheck() call would be a token/network cost regression. */
		const watched = <T extends { name: string }>(provider: T) =>
			new Proxy(provider, {
				get(target, property, receiver) {
					if (property === "healthCheck") {
						return () => {
							probes.push(target.name)
							return Promise.resolve({ ok: true, detail: "" })
						}
					}
					return Reflect.get(target, property, receiver)
				},
			})
		const payload = buildHealthPayload(config as never, {
			llm: watched(providers.llm),
			embeddings: watched(providers.embeddings),
			knowledge: watched(providers.knowledge),
			vectorStore: watched(providers.vectorStore),
			auth: watched(providers.auth),
			actions: watched(providers.incidentActions),
			storage: watched(providers.storage),
		} as never)
		assert.deepEqual(probes, [], "health invoked a provider healthCheck()")
		assert.equal(payload.liveProbe, false)
		assert.equal(payload.modeBadge, "AZURE CONFIGURED")
		assert.equal(payload.ok, true)
		assert.equal(payload.isFullyLocal, false)
	})
})

/* --------------------- the Azure side still fails loudly ------------------ */

test("each Azure provider still refuses to start with incomplete configuration", () => {
	// Removing an Azure setting must fail; it must never quietly load a local
	// implementation just because the action executor happens to be local.
	withEnv(demoEnv({ AZURE_SEARCH_ADMIN_KEY: "" }), () => {
		assert.throws(() => getConfig(), ConfigError)
	})
	withEnv(demoEnv({ AZURE_STORAGE_CONNECTION_STRING: "" }), () => {
		assert.throws(() => getConfig(), ConfigError)
	})
	withEnv(demoEnv({ ENTRA_REDIRECT_URI: "" }), () => {
		assert.throws(() => getConfig(), ConfigError)
	})
	withEnv(demoEnv({ DATABASE_URL: "" }), () => {
		assert.throws(() => getConfig(), ConfigError)
	})
})

test("the SPA remains a public client: an Entra client secret is refused", () => {
	withEnv(demoEnv({ ENTRA_CLIENT_SECRET: "should-not-exist" }), () => {
		assert.throws(() => getConfig(), ConfigError)
	})
})

test("Entra mode pins the port to the registered redirect URI", () => {
	withEnv(demoEnv(), () => {
		const config = getConfig()
		assert.equal(config.server.port, 4317, "the port must come from ENTRA_REDIRECT_URI")
		assert.equal(config.server.allowPortFallback, false, "an unregistered origin would break sign-in")
	})
	withEnv(demoEnv({ PORT: "5000" }), () => {
		assert.throws(
			() => getConfig(),
			(error: unknown) => {
				assert.match((error as Error).message, /contradicts ENTRA_REDIRECT_URI/)
				return true
			},
		)
	})
})
