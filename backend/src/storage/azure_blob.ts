/**
 * AzureBlobStorageProvider - production/Azure mode.
 *
 * Wraps the Shared Key REST client in backend/src/azure/blob.ts. The container
 * (`documents`) is private: no SAS URL and no public URL is ever produced, and
 * every read is mediated by an authorized NOVA request.
 */
import { Readable } from "node:stream"

import { BlobClient, SINGLE_SHOT_LIMIT_BYTES } from "../azure/blob.ts"
import {
	StorageError,
	assertSafeObjectKey,
	contentTypeForExtension,
	type ObjectMetadata,
	type PutOptions,
	type PutResult,
	type StorageProvider,
} from "./base.ts"

function extensionOfKey(key: string): string {
	const match = /\.([A-Za-z0-9]{1,10})$/.exec(key)
	return match ? `.${match[1].toLowerCase()}` : ""
}

/** x-ms-meta values must be ASCII header-safe; operational fields only. */
function sanitizeMetadata(metadata: Record<string, string> = {}): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(metadata)) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue
		const clean = String(value).replace(/[^\x20-\x7E]/g, "").slice(0, 256)
		if (clean) out[key] = clean
	}
	return out
}

export class AzureBlobStorageProvider implements StorageProvider {
	readonly name = "azure-blob-storage"
	readonly mode = "azure_blob" as const

	constructor(private readonly client: BlobClient) {}

	get container(): string {
		return this.client.container
	}

	/** Account + container only; the connection string never appears here. */
	describe(): string {
		return this.client.descriptor
	}

	async put(key: string, body: Buffer | Readable, options: PutOptions = {}): Promise<PutResult> {
		assertSafeObjectKey(key)
		const contentType = options.contentType || contentTypeForExtension(extensionOfKey(key))
		const uploadOptions = {
			contentType,
			contentDisposition: options.contentDisposition,
			cacheControl: options.cacheControl,
			metadata: sanitizeMetadata(options.metadata),
		}
		// Small/medium documents go up in a single request; anything larger is
		// staged in 4 MiB blocks so memory stays flat.
		if (Buffer.isBuffer(body) && body.byteLength <= SINGLE_SHOT_LIMIT_BYTES) {
			const result = await this.client.putBlob(key, body, uploadOptions)
			return { key, size: result.size, contentType, etag: result.etag }
		}
		const stream = Buffer.isBuffer(body) ? Readable.from(body) : body
		const result = await this.client.putBlobFromStream(key, stream, uploadOptions)
		return { key, size: result.size, contentType, etag: result.etag }
	}

	async get(key: string): Promise<Buffer> {
		assertSafeObjectKey(key)
		const result = await this.client.getBlob(key)
		if (!result) throw new StorageError("The stored document file was not found.", 404, "not_found")
		return result.body
	}

	async getStream(key: string): Promise<Readable> {
		assertSafeObjectKey(key)
		const result = await this.client.getBlobStream(key)
		if (!result) throw new StorageError("The stored document file was not found.", 404, "not_found")
		return result.stream
	}

	async exists(key: string): Promise<boolean> {
		assertSafeObjectKey(key)
		return (await this.client.headBlob(key)) !== null
	}

	async head(key: string): Promise<ObjectMetadata | null> {
		assertSafeObjectKey(key)
		const headers = await this.client.headBlob(key)
		if (!headers) return null
		const metadata: Record<string, string> = {}
		headers.forEach?.((value, name) => {
			if (name.toLowerCase().startsWith("x-ms-meta-")) metadata[name.toLowerCase().slice("x-ms-meta-".length)] = value
		})
		return {
			key,
			size: Number(headers.get("content-length") ?? 0),
			contentType: headers.get("content-type") || contentTypeForExtension(extensionOfKey(key)),
			lastModified: headers.get("last-modified"),
			metadata,
		}
	}

	async delete(key: string): Promise<boolean> {
		assertSafeObjectKey(key)
		return this.client.deleteBlob(key)
	}

	/** Explicit diagnostics only (npm run storage:validate / storage:init). */
	get blobClient(): BlobClient {
		return this.client
	}
}
