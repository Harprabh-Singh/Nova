import type { LLMProvider } from "./base.ts"
import { LocalLLMProvider } from "./local.ts"
import { AzureFoundryLLMProvider } from "./azure_foundry.ts"
import { getConfig } from "../config/index.ts"

export function createLLMProvider(): LLMProvider {
	const config = getConfig()
	if (config.modes.aiMode === "azure") {
		// AI_MODE=azure means Azure. If the provider cannot be constructed the
		// process fails here rather than quietly serving local answers.
		return new AzureFoundryLLMProvider({
			endpoint: config.azure?.foundry.endpoint ?? "",
			deployment: config.azure?.foundry.deployment ?? "",
			apiKey: config.azure?.apiKey,
			bearerToken: config.azure?.accessToken || undefined,
			project: config.azure?.foundry.project,
		})
	}
	return new LocalLLMProvider({
		baseUrl: config.localLlm.baseUrl,
		model: config.localLlm.model,
		apiKey: config.localLlm.apiKey,
		timeoutMs: config.localLlm.timeoutMs,
	})
}

export type { LLMProvider, CompletionRequest, CompletionResult, EvidenceItem } from "./base.ts"
export { LLMError } from "./base.ts"
