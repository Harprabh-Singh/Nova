/**
 * Storage provider abstraction.
 *
 *   StorageProvider
 *   ├── LocalStorageProvider      local/demo mode  -> filesystem (STORAGE_DIR)
 *   └── AzureBlobStorageProvider  production/Azure -> Azure Blob Storage
 *
 * The application never learns where a document actually lives: `documents/service.ts`
 * only ever holds an *object key* and calls this interface. Keys are generated on the
 * server from database identifiers, never from client input.
 */
import { Readable } from "node:stream"

export type StorageErrorCategory =
	/** Configuration is missing or invalid: this never becomes a silent fallback. */
	| "config"
	| "not_found"
	| "auth"
	| "bad_request"
	| "conflict"
	| "rate_limit"
	| "upstream"
	| "network"
	| "timeout"
	/** Local filesystem failure. */
	| "io"

/** Mirrors SearchError/FoundryError: structured, credential-free, never flattened. */
export class StorageError extends Error {
	constructor(
		message: string,
		readonly statusCode = 502,
		readonly category: StorageErrorCategory = "upstream",
		readonly upstreamStatus?: number,
		/** Azure correlation id when the response carried one. Safe to log. */
		readonly requestId?: string,
	) {
		super(message)
		this.name = "StorageError"
	}

	get diagnostic(): string {
		return `[${this.category}/${this.statusCode}${this.upstreamStatus ? ` upstream=${this.upstreamStatus}` : ""}${this.requestId ? ` req=${this.requestId}` : ""}] ${this.message}`
	}

	/** Safe, generic text for an API response. Never carries upstream detail. */
	get publicMessage(): string {
		switch (this.category) {
			case "not_found":
				return "The stored document file is no longer available."
			case "rate_limit":
				return "Document storage is rate limited. Please retry shortly."
			case "timeout":
				return "Document storage timed out. Please retry."
			case "config":
				return "Document storage is not configured correctly."
			default:
				return "Document storage is unavailable. Please retry."
		}
	}
}

export type StorageMode = "local" | "azure_blob"

export type ObjectMetadata = {
	key: string
	size: number
	contentType: string
	lastModified: string | null
	/** Operational metadata only (tenantId/documentId/versionId). Never ACLs or secrets. */
	metadata: Record<string, string>
}

export type PutOptions = {
	contentType?: string
	contentDisposition?: string
	cacheControl?: string
	/** Operational metadata only. Values must be non-sensitive ASCII. */
	metadata?: Record<string, string>
}

export type PutResult = { key: string; size: number; contentType: string; etag?: string | null }

export interface StorageProvider {
	readonly name: string
	readonly mode: StorageMode
	/** Container name (Azure) or the root directory label (local). Never a credential. */
	readonly container: string
	/** Safe descriptor for logs and diagnostics. Never contains a credential. */
	describe(): string
	put(key: string, body: Buffer | Readable, options?: PutOptions): Promise<PutResult>
	get(key: string): Promise<Buffer>
	getStream(key: string): Promise<Readable>
	exists(key: string): Promise<boolean>
	/** Returns null when the object does not exist. */
	head(key: string): Promise<ObjectMetadata | null>
	/** Idempotent: returns false when the object was already gone. */
	delete(key: string): Promise<boolean>
}

/* ------------------------- object key generation -------------------------- */

/**
 * Deterministic, tenant-safe object key:
 *
 *   tenant/<tenantId>/document/<documentId>/version/<versionId>/original.<ext>
 *
 * Properties this guarantees:
 *  - the tenant, document and version are all encoded in the path, so an object
 *    can always be proved to belong to the database row that references it;
 *  - the same (tenant, document, version) always produces the same key, so an
 *    interrupted upload can be retried without orphaning a second object;
 *  - the original filename is never the identity of the object (only its
 *    extension survives, from a fixed allowlist), so hostile names cannot shape
 *    the path.
 */
export const OBJECT_KEY_PREFIX = "tenant"

/** Extensions NOVA accepts, mirroring documents/extract.ts. */
export const ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt", ".docx", ".pdf"] as const

export const CONTENT_TYPES: Record<string, string> = {
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pdf": "application/pdf",
}

export function contentTypeForExtension(extension: string): string {
	return CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream"
}

/** Identifier segments are NOVA-generated ids; anything else is rejected outright. */
const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

export function assertSafeSegment(value: string, field: string): string {
	const candidate = String(value ?? "")
	if (!ID_SEGMENT.test(candidate) || candidate.includes("..")) {
		throw new StorageError(`Invalid ${field} for a storage object key.`, 400, "bad_request")
	}
	return candidate
}

/**
 * Reduces a client-supplied filename to a safe extension. Path separators, drive
 * letters, traversal sequences and unknown extensions never reach the key.
 */
export function safeExtension(filename: string): string {
	const base = String(filename ?? "")
		.replace(/\\/g, "/")
		.split("/")
		.pop() ?? ""
	const match = /\.([A-Za-z0-9]{1,10})$/.exec(base)
	const extension = match ? `.${match[1].toLowerCase()}` : ""
	return (ALLOWED_EXTENSIONS as readonly string[]).includes(extension) ? extension : ""
}

export function buildObjectKey(input: {
	tenantId: string
	documentId: string
	versionId: string
	filename: string
}): string {
	const tenantId = assertSafeSegment(input.tenantId, "tenant id")
	const documentId = assertSafeSegment(input.documentId, "document id")
	const versionId = assertSafeSegment(input.versionId, "version id")
	const extension = safeExtension(input.filename)
	return `${OBJECT_KEY_PREFIX}/${tenantId}/document/${documentId}/version/${versionId}/original${extension}`
}

/** The prefix every object of one tenant shares. Used for ownership checks. */
export function tenantKeyPrefix(tenantId: string): string {
	return `${OBJECT_KEY_PREFIX}/${assertSafeSegment(tenantId, "tenant id")}/`
}

/**
 * Structural validation of an object key. Applied by every provider before it
 * touches a filesystem path or a blob URL, so a key that somehow reached the
 * database from elsewhere still cannot escape its container.
 */
export function isSafeObjectKey(key: string): boolean {
	if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false
	if (key.includes("\\") || key.includes("\0")) return false
	if (key.startsWith("/") || key.endsWith("/")) return false
	if (/^[A-Za-z]:/.test(key)) return false
	if (/%2e|%2f|%5c/i.test(key)) return false
	const segments = key.split("/")
	if (segments.length < 2) return false
	for (const segment of segments) {
		if (!segment || segment === "." || segment === "..") return false
		if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(segment)) return false
	}
	return true
}

export function assertSafeObjectKey(key: string): string {
	if (!isSafeObjectKey(key)) {
		throw new StorageError("Invalid storage object key.", 400, "bad_request")
	}
	return key
}

/** Object keys carry the tenant: a row can always be checked against its file. */
export function keyBelongsToTenant(key: string, tenantId: string): boolean {
	try {
		return assertSafeObjectKey(key).startsWith(tenantKeyPrefix(tenantId))
	} catch {
		return false
	}
}

export function isStorageError(error: unknown): error is StorageError {
	return error instanceof StorageError || (error as { name?: string })?.name === "StorageError"
}

export { Readable }
