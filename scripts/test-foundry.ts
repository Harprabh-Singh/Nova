/**
 * Microsoft Foundry connectivity check.
 *
 *   npm run test:foundry
 *
 * Exercises the REAL NOVA providers (no duplicate client, no parallel
 * implementation) against the configured Foundry project:
 *
 *   1. chat       -> FOUNDRY_MODEL_DEPLOYMENT      (nova-chat, GPT-4.1-mini)
 *   2. embeddings -> AZURE_EMBEDDING_DEPLOYMENT    (nova-embedding, text-embedding-3-small)
 *
 * Credentials come exclusively from the environment (AZURE_API_KEY, or an
 * Entra access token in AZURE_ACCESS_TOKEN). This script never prints a
 * credential, never prints raw vectors, and exits non-zero on any failure.
 */
import process from "node:process"

import { loadEnv } from "../backend/src/config/index.ts"
import { AzureFoundryLLMProvider } from "../backend/src/llm/azure_foundry.ts"
import { AzureEmbeddingProvider } from "../backend/src/embeddings/azure.ts"

loadEnv()

const EXPECTED_REPLY = "NOVA Azure connection works."

function required(name: string): string {
	const value = (process.env[name] ?? "").trim()
	if (!value) {
		console.error(`FAIL  missing required environment variable: ${name}`)
		console.error("      Set it in .env (see .env.example). Never commit a real key.")
		process.exit(1)
	}
	return value
}

function mask(value: string): string {
	// Presence indicator only - the value itself is never printed.
	return value ? `present (${value.length} chars)` : "missing"
}

async function main(): Promise<void> {
	const endpoint = required("FOUNDRY_ENDPOINT")
	const chatDeployment = required("FOUNDRY_MODEL_DEPLOYMENT")
	const embeddingDeployment = required("AZURE_EMBEDDING_DEPLOYMENT")
	const project = (process.env.FOUNDRY_PROJECT ?? "").trim()
	const apiKey = (process.env.AZURE_API_KEY ?? "").trim()
	const bearerToken = (process.env.AZURE_ACCESS_TOKEN ?? "").trim()
	const dim = Number(process.env.EMBEDDING_DIM ?? 384)

	if (!apiKey && !bearerToken) {
		console.error("FAIL  no credential found: set AZURE_API_KEY or AZURE_ACCESS_TOKEN")
		process.exit(1)
	}

	console.log("NOVA -> Microsoft Foundry connectivity check")
	console.log(`  Project:              ${project || "(FOUNDRY_PROJECT not set)"}`)
	console.log(`  Endpoint:             ${endpoint}`)
	console.log(`  Chat deployment:      ${chatDeployment}`)
	console.log(`  Embedding deployment: ${embeddingDeployment}`)
	console.log(`  Credential:           ${bearerToken ? "Entra bearer token" : "api-key"} ${mask(bearerToken || apiKey)}`)
	console.log("")

	let failures = 0

	/* ---------------------------- 1. chat ------------------------------- */
	try {
		const llm = new AzureFoundryLLMProvider({
			endpoint,
			deployment: chatDeployment,
			apiKey: apiKey || undefined,
			bearerToken: bearerToken || undefined,
			project: project || undefined,
		})
		const completion = await llm.complete({
			messages: [
				{ role: "system", content: "Reply with exactly the text the user asks for. No extra words." },
				{ role: "user", content: `Reply with exactly: ${EXPECTED_REPLY}` },
			],
			temperature: 0,
			maxTokens: 32,
		})
		const text = completion.text.trim()
		console.log(`CHAT  model reply: ${text}`)
		console.log(`CHAT  latency: ${completion.latencyMs}ms  isFallback: ${completion.isFallback}`)
		if (completion.isFallback) {
			console.error("CHAT FAIL  returned a local fallback instead of a real Foundry completion")
			failures += 1
		} else if (text !== EXPECTED_REPLY) {
			console.error(`CHAT FAIL  expected exactly "${EXPECTED_REPLY}"`)
			failures += 1
		} else {
			console.log("CHAT PASS")
		}
	} catch (error) {
		console.error(`CHAT FAIL  ${(error as Error).message}`)
		failures += 1
	}

	console.log("")

	/* -------------------------- 2. embeddings --------------------------- */
	try {
		const embeddings = new AzureEmbeddingProvider({
			endpoint,
			deployment: embeddingDeployment,
			apiKey: apiKey || undefined,
			bearerToken: bearerToken || undefined,
			dim,
		})
		const vector = await embeddings.embedOne("What is the machine failure procedure?")
		// Only the dimension count is printed - never the vector contents.
		console.log(`Dimensions: ${vector.length}`)
		if (vector.length !== dim) {
			console.error(`EMBEDDING FAIL  expected ${dim} dimensions (EMBEDDING_DIM); got ${vector.length}`)
			failures += 1
		} else {
			console.log("EMBEDDING PASS")
		}
	} catch (error) {
		console.error(`EMBEDDING FAIL  ${(error as Error).message}`)
		failures += 1
	}

	console.log("")
	if (failures > 0) {
		console.error(`RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"} failed)`)
		process.exit(1)
	}
	console.log("RESULT: PASS")
}

main().catch((error) => {
	console.error(`RESULT: FAIL (unexpected error: ${(error as Error).message})`)
	process.exit(1)
})
