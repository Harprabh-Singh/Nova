/**
 * `/api/health` zero-token guarantee.
 *
 * The health payload must be built from local configuration and provider
 * identity only. These tests hand `buildHealthPayload` provider stubs whose
 * `healthCheck()` methods increment a counter and then assert the counter is
 * still zero: if anyone reintroduces a live Foundry chat "ping" or embedding
 * "health" probe, these tests fail.
 *
 * They also assert the payload never leaks credentials, endpoints or upstream
 * error text, and never claims a verified/connected Azure state.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
	buildHealthPayload,
	type HealthConfig,
	type HealthProviders,
} from "../backend/src/api/health.ts"

const FAKE_KEY = "fake-credential-value-not-a-real-key"
const FAKE_TOKEN = "fake-access-token-value"
/** Structurally shaped like a connection string, but not a credential. */
const FAKE_CONNECTION_STRING =
	"DefaultEndpointsProtocol=https;AccountName=novastorage;AccountKey=ZmFrZS1rZXktZm9yLXRlc3Rz;EndpointSuffix=core.windows.net"
const ENDPOINT = "https://example.services.ai.azure.com/api/projects/nova-foundry"

/** Counts every probe attempt so the tests can prove none happened. */
class ProbeCounter {
	calls: string[] = []
	probe(name: string) {
		this.calls.push(name)
		throw new Error(`health must never call ${name}.healthCheck()`)
	}
}

function spyProviders(counter: ProbeCounter, overrides: Record<string, unknown> = {}): HealthProviders {
	const spy = (name: string, extra: Record<string, unknown>) => ({
		name,
		...extra,
		healthCheck: async () => counter.probe(name),
	})
	return {
		llm: spy("azure_foundry", { mode: "azure", model: "nova-chat" }),
		embeddings: spy("azure_embeddings", { mode: "azure", model: "nova-embedding", dim: 1536 }),
		knowledge: spy("azure_search_knowledge", { mode: "azure" }),
		vectorStore: spy("azure_search", { mode: "azure_search" }),
		auth: spy("entra", { mode: "entra", isProduction: true }),
		actions: spy("azure_actions", { mode: "azure", simulated: false }),
		storage: spy("azure-blob-storage", { mode: "azure_blob" }),
		...overrides,
	} as unknown as HealthProviders
}

function localSpyProviders(counter: ProbeCounter): HealthProviders {
	const spy = (name: string, extra: Record<string, unknown>) => ({
		name,
		...extra,
		healthCheck: async () => counter.probe(name),
	})
	return {
		llm: spy("local_llm", { mode: "local", model: "llama" }),
		embeddings: spy("local_embeddings", { mode: "local", model: "minilm", dim: 384 }),
		knowledge: spy("local_knowledge", { mode: "local" }),
		vectorStore: spy("local_vector", { mode: "local" }),
		auth: spy("demo_auth", { mode: "demo", isProduction: false }),
		actions: spy("local_actions", { mode: "local", simulated: true }),
		storage: spy("local-filesystem", { mode: "local" }),
	} as unknown as HealthProviders
}

function azureConfig(overrides: Partial<HealthConfig> = {}): HealthConfig {
	return {
		appMode: "azure",
		isFullyLocal: false,
		modes: {
			aiMode: "azure",
			knowledgeMode: "azure",
			authMode: "entra",
			actionMode: "azure",
			vectorStore: "azure_search",
			storageMode: "azure_blob",
		},
		embeddings: { dim: 1536 },
		azure: {
			foundry: { endpoint: ENDPOINT, deployment: "nova-chat", embeddingDeployment: "nova-embedding" },
			search: { endpoint: "https://example.search.windows.net", index: "nova-index", adminKey: "test-only-not-a-real-key" },
			storage: { account: "novastorage", container: "documents", connectionString: FAKE_CONNECTION_STRING },
			entra: { tenantId: "tenant", clientId: "client", audience: "api://nova" },
			action: { workflowUrl: "https://example.logic.azure.com/workflows/nova" },
			apiKey: FAKE_KEY,
			accessToken: FAKE_TOKEN,
		},
		...overrides,
	}
}

function localConfig(): HealthConfig {
	return {
		appMode: "local",
		isFullyLocal: true,
		modes: {
			aiMode: "local",
			knowledgeMode: "local",
			authMode: "demo",
			actionMode: "local",
			vectorStore: "local",
			storageMode: "local",
		},
		embeddings: { dim: 384 },
		azure: null,
	}
}

/* --------------------------- the zero-token rule -------------------------- */

test("building the health payload never probes the chat or embedding providers", () => {
	const counter = new ProbeCounter()
	buildHealthPayload(azureConfig(), spyProviders(counter))
	assert.deepEqual(counter.calls, [], "health invoked a provider healthCheck()")
})

test("the local health payload also performs no probes", () => {
	const counter = new ProbeCounter()
	const payload = buildHealthPayload(localConfig(), localSpyProviders(counter))
	assert.deepEqual(counter.calls, [])
	assert.equal(payload.modeBadge, "LOCAL DEMO MODE")
	assert.equal(payload.isFullyLocal, true)
	assert.equal(payload.ok, true)
})

test("buildHealthPayload is synchronous, so no await can hide a remote call", () => {
	const counter = new ProbeCounter()
	const payload = buildHealthPayload(azureConfig(), spyProviders(counter))
	assert.ok(!(payload instanceof Promise))
	assert.equal(payload.liveProbe, false)
})

/* ------------------------------ honest status ----------------------------- */

test("a complete azure configuration reports AZURE CONFIGURED, not connected", () => {
	const counter = new ProbeCounter()
	const payload = buildHealthPayload(azureConfig(), spyProviders(counter))
	assert.equal(payload.modeBadge, "AZURE CONFIGURED")
	assert.equal(payload.status, "healthy")
	assert.equal(payload.azureConfigured, true)
	assert.equal(payload.azure.status, "configured")
	assert.equal(payload.checks.foundry, "configured")
	assert.equal(payload.checks.embeddings, "configured")
	assert.deepEqual(counter.calls, [])
})

test("missing azure settings report AZURE CONFIGURED - INCOMPLETE", () => {
	const counter = new ProbeCounter()
	const config = azureConfig()
	config.azure!.apiKey = ""
	config.azure!.accessToken = ""
	const payload = buildHealthPayload(config, spyProviders(counter))
	assert.equal(payload.modeBadge, "AZURE CONFIGURED - INCOMPLETE")
	assert.equal(payload.status, "configuration_incomplete")
	assert.equal(payload.ok, false)
	assert.equal(payload.azureConfigured, false)
	assert.ok(payload.azureReadiness.incompleteComponents.includes("llm"))
	assert.deepEqual(counter.calls, [])
})

test("an azure mode running a local implementation is reported as misconfigured", () => {
	const counter = new ProbeCounter()
	const providers = spyProviders(counter, {
		llm: { name: "local_llm", mode: "local", healthCheck: async () => counter.probe("local_llm") },
	})
	const payload = buildHealthPayload(azureConfig(), providers)
	assert.equal(payload.azureReadiness.components.llm.state, "misconfigured")
	assert.equal(payload.checks.foundry, "not_configured")
	assert.equal(payload.providers.llm.configured, false)
	assert.deepEqual(counter.calls, [])
})

test("the payload never claims a verified or connected Azure state", () => {
	const counter = new ProbeCounter()
	const serialized = JSON.stringify(buildHealthPayload(azureConfig(), spyProviders(counter)))
	assert.doesNotMatch(serialized, /CONNECTED/)
	assert.doesNotMatch(serialized, /verified/i)
	assert.match(serialized, /"liveProbe":false/)
})

/* --------------------------------- safety --------------------------------- */

test("the payload contains no credentials and no endpoints", () => {
	const counter = new ProbeCounter()
	const serialized = JSON.stringify(buildHealthPayload(azureConfig(), spyProviders(counter)))
	assert.ok(!serialized.includes(FAKE_KEY))
	assert.ok(!serialized.includes(FAKE_TOKEN))
	assert.ok(!serialized.includes(ENDPOINT))
	assert.ok(!serialized.includes("search.windows.net"))
	assert.ok(!serialized.includes("logic.azure.com"))
	// Phase 5: the storage connection string and account key never appear either.
	assert.ok(!serialized.includes(FAKE_CONNECTION_STRING))
	assert.ok(!serialized.includes("AccountKey"))
	assert.ok(!serialized.includes("ZmFrZS1rZXktZm9yLXRlc3Rz"))
})

test("health reports storage readiness from configuration alone", () => {
	const counter = new ProbeCounter()
	const payload = buildHealthPayload(azureConfig(), spyProviders(counter))
	assert.equal(payload.checks.storage, "configured")
	assert.equal(payload.providers.storage.mode, "azure_blob")
	assert.equal(payload.azureReadiness.components.storage.state, "configured")
	// No blob request of any kind was made to reach that conclusion.
	assert.deepEqual(counter.calls, [])
})

test("azure blob storage without a connection string is reported incomplete", () => {
	const counter = new ProbeCounter()
	const config = azureConfig()
	config.azure!.storage.connectionString = ""
	const payload = buildHealthPayload(config, spyProviders(counter))
	assert.equal(payload.ok, false)
	assert.ok(payload.azureReadiness.incompleteComponents.includes("storage"))
	assert.match(payload.azureReadiness.components.storage.detail ?? "", /AZURE_STORAGE_CONNECTION_STRING/)
	assert.deepEqual(counter.calls, [])
})

test("provider entries expose identity only, never upstream diagnostics", () => {
	const counter = new ProbeCounter()
	const payload = buildHealthPayload(azureConfig(), spyProviders(counter))
	for (const entry of Object.values(payload.providers)) {
		assert.equal((entry as Record<string, unknown>).detail, undefined)
		assert.equal((entry as Record<string, unknown>).ok, undefined)
		assert.equal((entry as Record<string, unknown>).endpoint, undefined)
	}
	assert.equal(payload.providers.llm.model, "nova-chat")
	assert.equal(payload.providers.embeddings.model, "nova-embedding")
})

test("incomplete component details name settings, never their values", () => {
	const counter = new ProbeCounter()
	const config = azureConfig()
	config.azure!.foundry.deployment = ""
	const payload = buildHealthPayload(config, spyProviders(counter))
	const detail = payload.azureReadiness.components.llm.detail ?? ""
	assert.match(detail, /FOUNDRY_MODEL_DEPLOYMENT/)
	assert.ok(!detail.includes(FAKE_KEY))
})
