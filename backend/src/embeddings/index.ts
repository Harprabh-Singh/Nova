import type { EmbeddingProvider } from "./base.ts"
import { LocalEmbeddingProvider } from "./local.ts"
import { AzureEmbeddingProvider } from "./azure.ts"
import { getConfig } from "../config/index.ts"

export function createEmbeddingProvider(): EmbeddingProvider {
	const config = getConfig()
	if (config.modes.aiMode === "azure") {
		return new AzureEmbeddingProvider({
			endpoint: config.azure?.foundry.endpoint ?? "",
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
