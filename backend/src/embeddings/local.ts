/**
 * LocalEmbeddingProvider.
 *
 * Two interchangeable local strategies, both offline-capable:
 *  1. HTTP: any OpenAI-compatible /embeddings server (LOCAL_EMBEDDING_BASE_URL).
 *  2. Built-in deterministic hashed-lexical embedder (default): stemmed token
 *     hashing into a configurable-dimension L2-normalised vector with bigrams.
 *     It is not a neural encoder, but it gives real vector similarity offline
 *     and is swapped out by changing configuration only.
 */
import { createHash } from "node:crypto"
import type { EmbeddingProvider } from "./base.ts"
import { log } from "../observability/logger.ts"

export type LocalEmbeddingOptions = {
	baseUrl?: string
	model: string
	dim: number
}

const STOP_WORDS = new Set([
	"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "be", "as", "at",
	"by", "with", "that", "this", "it", "from", "was", "were", "will", "shall", "may", "must",
])

/** Very light suffix stemmer - enough to align "approvals"/"approval"/"approved". */
export function stem(token: string): string {
	let t = token
	for (const suffix of ["ization", "isation", "ments", "ment", "ions", "ion", "ing", "ies", "ers", "er", "ed", "es", "s"]) {
		if (t.length > suffix.length + 3 && t.endsWith(suffix)) {
			t = t.slice(0, -suffix.length)
			break
		}
	}
	return t
}

export function tokenize(text: string): string[] {
	const raw = text
		.toLowerCase()
		.replace(/[^a-z0-9₹%._-]+/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1 && !STOP_WORDS.has(t))
	return raw.map(stem)
}

function hashToIndex(token: string, dim: number): { index: number; sign: number } {
	const digest = createHash("sha1").update(token).digest()
	const value = digest.readUInt32BE(0)
	return { index: value % dim, sign: digest[4] % 2 === 0 ? 1 : -1 }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly name = "LocalEmbeddingProvider"
	readonly mode = "local" as const

	constructor(private readonly options: LocalEmbeddingOptions) {}

	get model(): string {
		return this.options.baseUrl ? this.options.model : "nova-hashed-lexical-v1"
	}

	get dim(): number {
		return this.options.dim
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (this.options.baseUrl) {
			try {
				return await this.embedViaHttp(texts)
			} catch (error) {
				log.warn("embeddings.local.endpoint_failed", { detail: (error as Error).message })
			}
		}
		return texts.map((text) => this.hashEmbed(text))
	}

	async embedOne(text: string): Promise<Float32Array> {
		return (await this.embed([text]))[0]
	}

	private async embedViaHttp(texts: string[]): Promise<Float32Array[]> {
		const response = await fetch(`${this.options.baseUrl!.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: this.options.model, input: texts }),
		})
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
		return data.data.map((d) => Float32Array.from(d.embedding))
	}

	/** Deterministic, offline, dependency-free lexical embedding. */
	hashEmbed(text: string): Float32Array {
		const dim = this.options.dim
		const vector = new Float32Array(dim)
		const tokens = tokenize(text)
		const counts = new Map<string, number>()
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
		for (let i = 0; i < tokens.length - 1; i += 1) {
			const bigram = `${tokens[i]}_${tokens[i + 1]}`
			counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
		}
		for (const [token, count] of counts) {
			const { index, sign } = hashToIndex(token, dim)
			// Sublinear term frequency damping.
			vector[index] += sign * (1 + Math.log(count))
		}
		let norm = 0
		for (let i = 0; i < dim; i += 1) norm += vector[i] * vector[i]
		norm = Math.sqrt(norm)
		if (norm > 0) for (let i = 0; i < dim; i += 1) vector[i] /= norm
		return vector
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string; model?: string }> {
		if (!this.options.baseUrl) {
			return {
				ok: true,
				detail: `Built-in deterministic local embedder (dim ${this.options.dim}).`,
				model: this.model,
			}
		}
		try {
			await this.embedViaHttp(["health"])
			return { ok: true, detail: `Local embedding server reachable at ${this.options.baseUrl}`, model: this.model }
		} catch (error) {
			return {
				ok: false,
				detail: `Local embedding server unreachable (${(error as Error).message}); using built-in embedder.`,
				model: this.model,
			}
		}
	}
}
