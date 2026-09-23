/**
 * Azure readiness computation and the `/api/health` payload.
 *
 * ZERO-TOKEN RULE
 * ---------------
 * Nothing in this module performs a remote call. `/api/health` answers only:
 *
 *   "is the backend alive, is the configuration valid, and are the expected
 *    provider implementations loaded?"
 *
 * It deliberately does NOT answer "can Azure Foundry serve a request right
 * now?". Answering that required a live chat/embedding call on every health
 * poll, which consumed model tokens for no operational benefit. Real Azure
 * connectivity is validated naturally by real application requests (chat and
 * embedding), which surface structured `LLMError` / `EmbeddingError` failures.
 *
 * Because no live probe happens here, the endpoint never claims
 * "AZURE CONNECTED". The strongest claim it can honestly make is
 * "AZURE CONFIGURED": the modes select Azure, the loaded provider instances
 * really are the Azure implementations, and the required non-secret settings
 * are present.
 */

export type ComponentState =
	/** Component is intentionally running the local/demo implementation. */
	| "local"
	/** Configured for Azure, correct implementation loaded, settings complete. */
	| "configured"
	/** Configured for Azure but required settings are missing/invalid. */
	| "incomplete"
	/** Configured for Azure but a local/demo implementation is actually loaded. */
	| "misconfigured"

export type AzureComponentStatus = {
	configured: boolean
	/** The provider instance's own `mode` value. Never an endpoint or secret. */
	implementation: string
	state: ComponentState
	/** Safe, generic explanation. Never an upstream error or credential. */
	detail?: string
}

export type ReadinessModes = {
	aiMode: "local" | "azure"
	knowledgeMode: "local" | "azure"
	authMode: "demo" | "entra"
	actionMode: "local" | "azure"
	vectorStore: "local" | "azure_search"
	/** Phase 5: where document FILES live. */
	storageMode: "local" | "azure_blob"
}

/** Identity of the provider instances that were actually constructed. */
export type ReadinessProviders = {
	llm: { mode: string }
	embeddings: { mode: string; dim?: number }
	knowledge: { mode: string }
	vectorStore: { mode: string }
	auth: { mode: string }
	actions: { mode: string }
	/** Phase 5 storage provider identity. Never a container URL or credential. */
	storage: { mode: string }
}

/**
 * Presence-only view of the Azure configuration. Values are never copied into
 * the health response; only booleans derived from them are.
 */
export type AzureConfigSnapshot = {
	foundry: { endpoint: string; deployment: string; embeddingDeployment: string; hasCredential: boolean }
	/** hasAdminKey is a boolean presence flag. The key itself never enters this snapshot. */
	search: { endpoint: string; index: string; hasAdminKey: boolean }
	/** hasConnectionString is a boolean presence flag. The secret never enters this snapshot. */
	storage: { account: string; container: string; hasConnectionString: boolean }
	entra: { tenantId: string; clientId: string; audience: string }
	/**
	 * Phase 8 added `functionUrl` (the NOVA Actions Function app). The Phase 4
	 * `workflowUrl` (Logic App / generic endpoint) is still accepted, so an
	 * existing deployment stays "configured" without being re-pointed.
	 */
	action: { workflowUrl: string; functionUrl?: string }
	embeddingDim: number
} | null

export type AzureReadiness = {
	badge: "LOCAL DEMO MODE" | "AZURE CONFIGURED" | "AZURE CONFIGURED - INCOMPLETE"
	status: "local" | "configured" | "configuration_incomplete"
	/** True when every Azure-selected component is complete and correctly loaded. */
	azureConfigured: boolean
	/** True when some, but not all, components are selected for Azure. */
	partial: boolean
	azureComponents: string[]
	/** Azure-selected components that are incomplete or misconfigured. */
	incompleteComponents: string[]
	components: Record<string, AzureComponentStatus>
}

/** Syntactic check only - no DNS lookup, no request. */
function isValidEndpoint(value: string): boolean {
	if (!value) return false
	try {
		const url = new URL(value)
		return url.protocol === "https:"
	} catch {
		return false
	}
}

type Requirement = {
	name: string
	selectedForAzure: boolean
	/** The provider `mode` proving the Azure implementation is loaded. */
	expectedMode: string
	actualMode: string
	/** Locally checkable settings this component needs, with safe labels. */
	missing: string[]
}

export function computeAzureReadiness(
	modes: ReadinessModes,
	providers: ReadinessProviders,
	azure: AzureConfigSnapshot,
): AzureReadiness {
	const foundryMissing: string[] = []
	const embeddingMissing: string[] = []
	const searchMissing: string[] = []
	const entraMissing: string[] = []
	const actionMissing: string[] = []
	const storageMissing: string[] = []

	if (!azure) {
		// Azure settings are only materialised when a mode asks for Azure. If a
		// mode does ask and the block is absent, everything is missing.
		foundryMissing.push("azure configuration")
		embeddingMissing.push("azure configuration")
		searchMissing.push("azure configuration")
		entraMissing.push("azure configuration")
		actionMissing.push("azure configuration")
		storageMissing.push("azure configuration")
	} else {
		if (!isValidEndpoint(azure.foundry.endpoint)) foundryMissing.push("FOUNDRY_ENDPOINT")
		if (!azure.foundry.deployment) foundryMissing.push("FOUNDRY_MODEL_DEPLOYMENT")
		if (!azure.foundry.hasCredential) foundryMissing.push("AZURE_API_KEY or AZURE_ACCESS_TOKEN")

		if (!isValidEndpoint(azure.foundry.endpoint)) embeddingMissing.push("FOUNDRY_ENDPOINT")
		if (!azure.foundry.embeddingDeployment) embeddingMissing.push("AZURE_EMBEDDING_DEPLOYMENT")
		if (!azure.foundry.hasCredential) embeddingMissing.push("AZURE_API_KEY or AZURE_ACCESS_TOKEN")
		if (!Number.isInteger(azure.embeddingDim) || azure.embeddingDim <= 0) embeddingMissing.push("EMBEDDING_DIM")

		if (!isValidEndpoint(azure.search.endpoint)) searchMissing.push("AZURE_SEARCH_ENDPOINT")
		if (!azure.search.index) searchMissing.push("AZURE_SEARCH_INDEX")
		if (!azure.search.hasAdminKey) searchMissing.push("AZURE_SEARCH_ADMIN_KEY")

		if (!azure.entra.tenantId) entraMissing.push("ENTRA_TENANT_ID")
		if (!azure.entra.clientId) entraMissing.push("ENTRA_CLIENT_ID")
		if (!azure.entra.audience) entraMissing.push("ENTRA_API_ID_URI")

		// Either execution seam satisfies the actions component: the Phase 8
		// Function app, or the Phase 4 workflow endpoint. Presence and https only -
		// no request is made to either.
		if (!isValidEndpoint(azure.action.functionUrl ?? "") && !isValidEndpoint(azure.action.workflowUrl)) {
			actionMissing.push("AZURE_ACTION_FUNCTION_URL (or AZURE_ACTION_WORKFLOW_URL)")
		}

		// Presence only. No container probe, no blob request: /api/health stays
		// local, synchronous and free of remote storage calls.
		if (!azure.storage.hasConnectionString) storageMissing.push("AZURE_STORAGE_CONNECTION_STRING")
		if (!azure.storage.container) storageMissing.push("AZURE_STORAGE_CONTAINER")
	}

	const requirements: Requirement[] = [
		{
			name: "llm",
			selectedForAzure: modes.aiMode === "azure",
			expectedMode: "azure",
			actualMode: providers.llm.mode,
			missing: foundryMissing,
		},
		{
			// Embeddings follow AI_MODE; there is no separate embedding mode.
			name: "embeddings",
			selectedForAzure: modes.aiMode === "azure",
			expectedMode: "azure",
			actualMode: providers.embeddings.mode,
			missing: embeddingMissing,
		},
		{
			name: "knowledge",
			selectedForAzure: modes.knowledgeMode === "azure",
			expectedMode: "azure",
			actualMode: providers.knowledge.mode,
			missing: searchMissing,
		},
		{
			name: "vectorStore",
			selectedForAzure: modes.vectorStore === "azure_search",
			expectedMode: "azure_search",
			actualMode: providers.vectorStore.mode,
			missing: searchMissing,
		},
		{
			name: "auth",
			selectedForAzure: modes.authMode === "entra",
			expectedMode: "entra",
			actualMode: providers.auth.mode,
			missing: entraMissing,
		},
		{
			name: "storage",
			selectedForAzure: modes.storageMode === "azure_blob",
			expectedMode: "azure_blob",
			actualMode: providers.storage.mode,
			missing: storageMissing,
		},
		{
			name: "actions",
			selectedForAzure: modes.actionMode === "azure",
			expectedMode: "azure",
			actualMode: providers.actions.mode,
			missing: actionMissing,
		},
	]

	const components: Record<string, AzureComponentStatus> = {}
	const azureComponents: string[] = []
	const incompleteComponents: string[] = []

	for (const item of requirements) {
		if (!item.selectedForAzure) {
			components[item.name] = { configured: false, implementation: item.actualMode, state: "local" }
			continue
		}
		azureComponents.push(item.name)
		if (item.actualMode !== item.expectedMode) {
			components[item.name] = {
				configured: false,
				implementation: item.actualMode,
				state: "misconfigured",
				detail: "configured for Azure but a non-Azure implementation is loaded",
			}
			incompleteComponents.push(item.name)
		} else if (item.missing.length > 0) {
			components[item.name] = {
				configured: false,
				implementation: item.actualMode,
				state: "incomplete",
				// Names of missing settings only - never their values.
				detail: `missing configuration: ${item.missing.join(", ")}`,
			}
			incompleteComponents.push(item.name)
		} else {
			components[item.name] = { configured: true, implementation: item.actualMode, state: "configured" }
		}
	}

	const anyAzure = azureComponents.length > 0
	const azureConfigured = anyAzure && incompleteComponents.length === 0

	return {
		badge: !anyAzure ? "LOCAL DEMO MODE" : azureConfigured ? "AZURE CONFIGURED" : "AZURE CONFIGURED - INCOMPLETE",
		status: !anyAzure ? "local" : azureConfigured ? "configured" : "configuration_incomplete",
		azureConfigured,
		partial: anyAzure && azureComponents.length !== requirements.length,
		azureComponents,
		incompleteComponents,
		components,
	}
}

/** Credential-free summary: "configured" / "not_configured" / "local". */
export function componentSummary(status: AzureComponentStatus | undefined): string {
	if (status?.state === "configured") return "configured"
	if (status?.state === "local") return "local"
	return "not_configured"
}

/* ------------------------------ health payload ---------------------------- */

/** The subset of config the health payload needs. Structural on purpose. */
export type HealthConfig = {
	appMode: string
	isFullyLocal: boolean
	modes: ReadinessModes
	embeddings: { dim: number }
	azure: {
		foundry: { endpoint: string; deployment: string; embeddingDeployment: string }
		/** adminKey is the raw secret from config; azureConfigSnapshot() reduces it to a boolean. */
		search: { endpoint: string; index: string; adminKey: string }
		/** connectionString is the raw secret from config; azureConfigSnapshot() reduces it to a boolean. */
		storage: { account: string; container: string; connectionString: string }
		entra: { tenantId: string; clientId: string; audience: string }
		action: { workflowUrl: string; functionUrl?: string }
		apiKey: string
		accessToken: string
	} | null
}

/** Provider identity as reported by the instances themselves. */
export type HealthProviders = {
	llm: { name: string; mode: string; model?: string }
	embeddings: { name: string; mode: string; model?: string; dim?: number }
	knowledge: { name: string; mode: string }
	vectorStore: { name: string; mode: string }
	auth: { name: string; mode: string; isProduction?: boolean }
	actions: { name: string; mode: string; simulated?: boolean }
	storage: { name: string; mode: string; container?: string }
}

/** Build the presence-only snapshot. Secrets are reduced to a boolean here. */
export function azureConfigSnapshot(config: HealthConfig): AzureConfigSnapshot {
	if (!config.azure) return null
	return {
		foundry: {
			endpoint: config.azure.foundry.endpoint,
			deployment: config.azure.foundry.deployment,
			embeddingDeployment: config.azure.foundry.embeddingDeployment,
			hasCredential: Boolean(config.azure.apiKey || config.azure.accessToken),
		},
		// Presence flag only: the admin key is never copied into the snapshot.
		search: { endpoint: config.azure.search.endpoint, index: config.azure.search.index, hasAdminKey: Boolean(config.azure.search.adminKey) },
		// Presence flag only: the connection string is never copied into the snapshot.
		storage: {
			account: config.azure.storage.account,
			container: config.azure.storage.container,
			hasConnectionString: Boolean(config.azure.storage.connectionString),
		},
		entra: {
			tenantId: config.azure.entra.tenantId,
			clientId: config.azure.entra.clientId,
			audience: config.azure.entra.audience,
		},
		// URLs, not secrets. AZURE_ACTION_FUNCTION_KEY never enters the snapshot.
		action: { workflowUrl: config.azure.action.workflowUrl, functionUrl: config.azure.action.functionUrl ?? "" },
		embeddingDim: config.embeddings.dim,
	}
}

export type HealthPayload = {
	ok: boolean
	status: "healthy" | "configuration_incomplete"
	modeBadge: AzureReadiness["badge"]
	appMode: string
	modes: ReadinessModes
	isFullyLocal: boolean
	/** No live probe is performed, so connectivity is explicitly never asserted. */
	liveProbe: false
	azure: { status: AzureReadiness["status"]; configured: boolean; partial: boolean }
	azureConfigured: boolean
	azureReadiness: {
		partial: boolean
		azureComponents: string[]
		incompleteComponents: string[]
		components: Record<string, AzureComponentStatus>
	}
	checks: { foundry: string; embeddings: string; search: string; auth: string; actions: string; storage: string }
	providers: Record<string, { name: string; mode: string; model?: string; dim?: number; isProduction?: boolean; simulated?: boolean; configured: boolean }>
}

/**
 * Build the `/api/health` body.
 *
 * Synchronous by design: an async signature invites a future `await
 * provider.healthCheck()` to creep back in. Everything here is local state.
 */
export function buildHealthPayload(config: HealthConfig, providers: HealthProviders): HealthPayload {
	const readiness = computeAzureReadiness(config.modes, providers, azureConfigSnapshot(config))
	const state = (name: string) => readiness.components[name]
	return {
		// The process answered, so it is alive. `ok` drops only when an Azure
		// mode is selected with incomplete or wrongly-loaded providers.
		ok: readiness.status !== "configuration_incomplete",
		status: readiness.status === "configuration_incomplete" ? "configuration_incomplete" : "healthy",
		modeBadge: readiness.badge,
		appMode: config.appMode,
		modes: config.modes,
		isFullyLocal: config.isFullyLocal,
		liveProbe: false,
		azure: { status: readiness.status, configured: readiness.azureConfigured, partial: readiness.partial },
		azureConfigured: readiness.azureConfigured,
		azureReadiness: {
			partial: readiness.partial,
			azureComponents: readiness.azureComponents,
			incompleteComponents: readiness.incompleteComponents,
			components: readiness.components,
		},
		checks: {
			foundry: componentSummary(state("llm")),
			embeddings: componentSummary(state("embeddings")),
			search: componentSummary(state("vectorStore")),
			auth: componentSummary(state("auth")),
			actions: componentSummary(state("actions")),
			storage: componentSummary(state("storage")),
		},
		// Provider identity only: no endpoints, no credentials, no upstream
		// diagnostics. `detail` from provider probes is deliberately absent.
		providers: {
			llm: {
				name: providers.llm.name,
				mode: providers.llm.mode,
				model: providers.llm.model,
				configured: state("llm")?.state !== "incomplete" && state("llm")?.state !== "misconfigured",
			},
			embeddings: {
				name: providers.embeddings.name,
				mode: providers.embeddings.mode,
				model: providers.embeddings.model,
				dim: providers.embeddings.dim,
				configured: state("embeddings")?.state !== "incomplete" && state("embeddings")?.state !== "misconfigured",
			},
			knowledge: {
				name: providers.knowledge.name,
				mode: providers.knowledge.mode,
				configured: state("knowledge")?.state !== "incomplete" && state("knowledge")?.state !== "misconfigured",
			},
			vectorStore: {
				name: providers.vectorStore.name,
				mode: providers.vectorStore.mode,
				configured: state("vectorStore")?.state !== "incomplete" && state("vectorStore")?.state !== "misconfigured",
			},
			auth: {
				name: providers.auth.name,
				mode: providers.auth.mode,
				isProduction: providers.auth.isProduction,
				configured: state("auth")?.state !== "incomplete" && state("auth")?.state !== "misconfigured",
			},
			actions: {
				name: providers.actions.name,
				mode: providers.actions.mode,
				simulated: providers.actions.simulated,
				configured: state("actions")?.state !== "incomplete" && state("actions")?.state !== "misconfigured",
			},
			// Identity only. No container name is required to answer "is storage
			// configured?", and no blob request is ever made to find out.
			storage: {
				name: providers.storage.name,
				mode: providers.storage.mode,
				configured: state("storage")?.state !== "incomplete" && state("storage")?.state !== "misconfigured",
			},
		},
	}
}
