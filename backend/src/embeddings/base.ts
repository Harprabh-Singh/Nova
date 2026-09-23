/** Embedding abstraction. The model name is configuration, never hard-coded. */
export interface EmbeddingProvider {
	readonly name: string
	readonly mode: "local" | "azure"
	readonly model: string
	readonly dim: number
	embed(texts: string[]): Promise<Float32Array[]>
	embedOne(text: string): Promise<Float32Array>
	healthCheck(): Promise<{ ok: boolean; detail: string; model?: string }>
}

/**
 * Structured embedding failure. Mirrors LLMError so provider diagnostics
 * (category, upstream status, correlation id) are not flattened into a bare
 * Error. Never carries credentials or raw provider payloads.
 */
export class EmbeddingError extends Error {
	constructor(
		message: string,
		/** Status NOVA will surface publicly. */
		readonly statusCode = 502,
		readonly category?: string,
		readonly upstreamStatus?: number,
		readonly requestId?: string,
	) {
		super(message)
		this.name = "EmbeddingError"
	}
}

export function cosine(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length)
	let dot = 0
	let na = 0
	let nb = 0
	for (let i = 0; i < n; i += 1) {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if (na === 0 || nb === 0) return 0
	return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function floatsToBuffer(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer.slice(0) as ArrayBuffer)
}

export function bufferToFloats(buffer: Uint8Array | null | undefined): Float32Array {
	if (!buffer || buffer.byteLength === 0) return new Float32Array(0)
	const copy = new Uint8Array(buffer)
	return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}
