import type { EmbeddingProvider } from "./base.ts"
import { LocalEmbeddingProvider } from "./local.ts"
import { AzureEmbeddingProvider } from "./azure.ts"
import { getConfig } from "../config/index.ts"

export function createEmbeddingProvider(): EmbeddingProvider {
	const config = getConfig()
	if (config.modes.aiMode === "azure") {
		return new AzureEmbeddingProvider({
			// embeddingEndpoint defaults to FOUNDRY_ENDPOINT when AZURE_EMBEDDING_ENDPOINT is
			// not set. Set AZURE_EMBEDDING_ENDPOINT to the resource-level Azure AI Services
			// endpoint (https://<resource>.services.ai.azure.com) when the embedding deployment
			// is served there rather than at the Foundry project endpoint.
			endpoint: config.azure?.foundry.embeddingEndpoint ?? config.azure?.foundry.endpoint ?? "",
			deployment: config.azure?.foundry.embeddingDeployment ?? "",
			apiKey: config.azure?.apiKey,
			bearerToken: config.azure?.accessToken || undefined,
			// Foundry is asked for NOVA's configured width; see embeddings/azure.ts.
			dim: config.embeddings.dim,
		})
	}
	return new LocalEmbeddingProvider({
		baseUrl: config.embeddings.baseUrl || undefined,
		model: config.embeddings.model,
		dim: config.embeddings.dim,
	})
}

export type { EmbeddingProvider } from "./base.ts"
export { cosine, bufferToFloats, floatsToBuffer } from "./base.ts"
