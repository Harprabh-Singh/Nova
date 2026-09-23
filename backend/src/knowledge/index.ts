import type { KnowledgeProvider } from "./base.ts"
import { LocalKnowledgeProvider } from "./local.ts"
import { AzureKnowledgeProvider } from "./azure_foundry_iq.ts"
import { LocalVectorStore } from "../retrieval/vector/local.ts"
import { AzureVectorStore } from "../retrieval/vector/azure.ts"
import type { VectorStore } from "../retrieval/vector/base.ts"
import type { EmbeddingProvider } from "../embeddings/base.ts"
import type { Database } from "../db/index.ts"
import { getConfig } from "../config/index.ts"

export function createVectorStore(db: Database): VectorStore {
	const config = getConfig()
	if (config.modes.vectorStore === "azure_search") {
		return createAzureVectorStore()
	}
	return new LocalVectorStore(db)
}

/**
 * Builds the Azure AI Search store from configuration. Shared by the runtime
 * factory and the search:* commands so there is exactly one place where the
 * endpoint, index, admin key and vector width are wired together.
 */
export function createAzureVectorStore(): AzureVectorStore {
	const config = getConfig()
	const search = config.azure?.search
	if (!search?.endpoint) throw new Error("VECTOR_STORE=azure_search requires AZURE_SEARCH_ENDPOINT")
	if (!search.adminKey) throw new Error("VECTOR_STORE=azure_search requires AZURE_SEARCH_ADMIN_KEY")
	return new AzureVectorStore({
		endpoint: search.endpoint,
		index: search.index,
		apiVersion: search.apiVersion,
		apiKey: search.adminKey,
		// The index vector width must equal the embedding provider's width.
		dimensions: config.embeddings.dim,
	})
}

export function createKnowledgeProvider(vectorStore: VectorStore, embeddings: EmbeddingProvider): KnowledgeProvider {
	const config = getConfig()
	if (config.modes.knowledgeMode === "azure") {
		return new AzureKnowledgeProvider(vectorStore, embeddings)
	}
	return new LocalKnowledgeProvider(vectorStore, embeddings)
}

export type { KnowledgeProvider, RetrievalRequest, RetrievalResult } from "./base.ts"
