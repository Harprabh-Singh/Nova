/**
 * Low-level Azure Blob Storage REST client (Shared Key authorization).
 *
 * Data plane operations used by NOVA:
 *   PUT    /{container}/{blob}                       Put Blob (single shot)
 *   PUT    /{container}/{blob}?comp=block&blockid=   Put Block   (streamed upload)
 *   PUT    /{container}/{blob}?comp=blocklist        Put Block List
 *   GET    /{container}/{blob}                       Get Blob
 *   HEAD   /{container}/{blob}                       Get Blob Properties
 *   DELETE /{container}/{blob}                       Delete Blob
 *   GET    /{container}?restype=container            Get Container Properties
 *   PUT    /{container}?restype=container            Create Container (explicit setup only)
 *
 * WHY REST AND NOT `@azure/storage-blob`
 * --------------------------------------
 * NOVA deliberately ships without vendor SDKs: Foundry (backend/src/azure/foundry.ts)
 * and Azure AI Search (backend/src/azure/search.ts) are both thin `fetch` clients,
 * and `package.json` carries a single runtime dependency (`pg`). Adding the Blob SDK
 * would pull a large dependency tree into a repository that is installed and audited
 * in restricted environments. This file follows the exact same shape as the Search
 * client: structured errors, bounded retries, scrubbed diagnostics, no logging of
 * credentials.
 *
 * Security notes:
 * - The account key only ever exists inside the Authorization signature. It is never
 *   logged, never placed in a URL, and never included in an error message.
 * - Azure error payloads are truncated and scrubbed before they reach a StorageError,
 *   so an upstream response can never carry a credential outward.
 * - No SAS URL is ever produced: downloads are mediated by the NOVA backend.
 */
import { createHash, createHmac } from "node:crypto"
import { Readable } from "node:stream"

import { StorageError, type StorageErrorCategory } from "../storage/base.ts"

/** Stable service version. Preview versions are deliberately not used. */
export const BLOB_API_VERSION = "2021-08-06"

/** Azure's Put Block limit is far higher; 4 MiB keeps memory flat for streamed uploads. */
export const BLOCK_SIZE_BYTES = 4 * 1024 * 1024
/** Above this size a single Put Blob is replaced by staged blocks. */
export const SINGLE_SHOT_LIMIT_BYTES = 8 * 1024 * 1024

export type BlobCredential = {
	accountName: string
	/** Raw (decoded) shared key. Never logged, never serialised. */
	accountKey: Buffer
	/** e.g. https://novastorage2376.blob.core.windows.net */
	endpoint: string
}

/**
 * Parses an AZURE_STORAGE_CONNECTION_STRING. Only Shared Key connection strings
 * are supported; anything else fails loudly rather than half-working.
 */
export function parseConnectionString(connectionString: string): BlobCredential {
	if (!connectionString || !connectionString.trim()) {
		throw new StorageError("AZURE_STORAGE_CONNECTION_STRING is required for Azure Blob storage.", 500, "config")
	}
	const parts = new Map<string, string>()
	for (const segment of connectionString.split(";")) {
		const eq = segment.indexOf("=")
		if (eq === -1) continue
		parts.set(segment.slice(0, eq).trim().toLowerCase(), segment.slice(eq + 1).trim())
	}
	const accountName = parts.get("accountname") ?? ""
	const accountKeyRaw = parts.get("accountkey") ?? ""
	if (!accountName || !accountKeyRaw) {
		throw new StorageError(
			"AZURE_STORAGE_CONNECTION_STRING is malformed: AccountName and AccountKey are required.",
			500,
			"config",
		)
	}
	let accountKey: Buffer
	try {
		accountKey = Buffer.from(accountKeyRaw, "base64")
		if (accountKey.byteLength === 0) throw new Error("empty")
	} catch {
		throw new StorageError("AZURE_STORAGE_CONNECTION_STRING contains an unreadable AccountKey.", 500, "config")
	}
	const protocol = (parts.get("defaultendpointsprotocol") || "https").toLowerCase()
	const suffix = parts.get("endpointsuffix") || "core.windows.net"
	const endpoint = (parts.get("blobendpoint") || `${protocol}://${accountName}.blob.${suffix}`).replace(/\/+$/, "")
	if (!endpoint.startsWith("https://")) {
		throw new StorageError("Azure Blob storage must use an https endpoint.", 500, "config")
	}
	return { accountName, accountKey, endpoint }
}

function categoryForStatus(status: number): StorageErrorCategory {
	if (status === 401 || status === 403) return "auth"
	if (status === 404) return "not_found"
	if (status === 409 || status === 412) return "conflict"
	if (status === 429) return "rate_limit"
	if (status === 503) return "rate_limit"
	if (status >= 400 && status < 500) return "bad_request"
	return "upstream"
}

/** Only transient classes are worth retrying; a wrong container fails identically forever. */
function isRetryable(category: StorageErrorCategory): boolean {
	return category === "rate_limit" || category === "upstream" || category === "network" || category === "timeout"
}

export function publicStatusForStorage(category: StorageErrorCategory): number {
	switch (category) {
		case "rate_limit":
			return 429
		case "timeout":
			return 504
		case "not_found":
			return 404
		case "config":
			return 500
		default:
			return 502
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Defence in depth: nothing credential-shaped may ride out on an error message. */
function scrub(text: string, secrets: string[]): string {
	let out = text.slice(0, 400)
	for (const secret of secrets) {
		if (secret && secret.length >= 8) out = out.split(secret).join("***")
	}
	return out
		.replace(/(AccountKey\s*=\s*)[^;"\s]+/gi, "$1***")
		.replace(/(SharedKey\s+[^:]+:)\S+/g, "$1***")
		.replace(/(sig=)[^&"\s]+/gi, "$1***")
}

export type BlobClientOptions = {
	connectionString: string
	container: string
	/** Optional cross-check: fails when it disagrees with the connection string. */
	expectedAccount?: string
	timeoutMs?: number
	maxRetries?: number
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch
	/** Injectable for tests so backoff does not actually sleep. */
	sleepImpl?: (ms: number) => Promise<void>
}

export type BlobRequestOptions = {
	method: string
	/** Unencoded resource path, e.g. "/documents/tenant/t1/.../original.pdf". */
	path: string
	query?: Record<string, string>
	body?: Buffer
	contentType?: string
	contentMd5?: string
	headers?: Record<string, string>
	/** When true a 404 resolves to null instead of throwing. */
	allowNotFound?: boolean
	/** When true the raw Response is returned so the caller can stream the body. */
	raw?: boolean
}

export type BlobResponse = {
	status: number
	headers: Headers
	body: Buffer
	/** Present only for `raw` requests. */
	response?: Response
}

/** A container name is server-controlled configuration, never client input. */
export function isValidContainerName(name: string): boolean {
	return /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(name)
}

export class BlobClient {
	readonly accountName: string
	readonly endpoint: string
	readonly container: string
	private readonly accountKey: Buffer
	private readonly timeoutMs: number
	private readonly maxRetries: number
	private readonly doFetch: typeof fetch
	private readonly doSleep: (ms: number) => Promise<void>
	private readonly secrets: string[]

	constructor(options: BlobClientOptions) {
		const credential = parseConnectionString(options.connectionString)
		if (!options.container) {
			throw new StorageError("AZURE_STORAGE_CONTAINER is required for Azure Blob storage.", 500, "config")
		}
		if (!isValidContainerName(options.container)) {
			throw new StorageError(
				`AZURE_STORAGE_CONTAINER "${options.container}" is not a valid Azure container name.`,
				500,
				"config",
			)
		}
		if (options.expectedAccount && options.expectedAccount !== credential.accountName) {
			throw new StorageError(
				"AZURE_STORAGE_ACCOUNT does not match the account in AZURE_STORAGE_CONNECTION_STRING.",
				500,
				"config",
			)
		}
		this.accountName = credential.accountName
		this.accountKey = credential.accountKey
		this.endpoint = credential.endpoint
		this.container = options.container
		this.timeoutMs = options.timeoutMs ?? 30_000
		this.maxRetries = options.maxRetries ?? 3
		this.doFetch = options.fetchImpl ?? fetch
		this.doSleep = options.sleepImpl ?? sleep
		// Everything that must never appear in a log line or error message.
		this.secrets = [options.connectionString, credential.accountKey.toString("base64")]
	}

	/** Account + container only. Contains no credential, so it is safe to log. */
	get descriptor(): string {
		return `${this.endpoint}/${this.container}`
	}

	/** Public helper so callers can scrub their own diagnostics with the same rules. */
	redact(text: string): string {
		return scrub(text, this.secrets)
	}

	private encodePath(path: string): string {
		return path
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/")
	}

	private authorize(options: {
		method: string
		path: string
		query: Record<string, string>
		contentLength: number
		contentType: string
		contentMd5: string
		xms: Record<string, string>
	}): string {
		const canonicalHeaders = Object.keys(options.xms)
			.map((key) => key.toLowerCase())
			.sort()
			.map((key) => `${key}:${String(options.xms[key] ?? options.xms[key.toLowerCase()]).replace(/\s+/g, " ").trim()}\n`)
			.join("")

		const canonicalResource =
			`/${this.accountName}${options.path}` +
			Object.keys(options.query)
				.map((k) => k.toLowerCase())
				.sort()
				.map((key) => `\n${key}:${options.query[key]}`)
				.join("")

		const stringToSign = [
			options.method.toUpperCase(),
			"", // Content-Encoding
			"", // Content-Language
			options.contentLength === 0 ? "" : String(options.contentLength),
			options.contentMd5,
			options.contentType,
			"", // Date (x-ms-date is used instead)
			"", // If-Modified-Since
			"", // If-Match
			"", // If-None-Match
			"", // If-Unmodified-Since
			"", // Range
			canonicalHeaders + canonicalResource,
		].join("\n")

		const signature = createHmac("sha256", this.accountKey).update(stringToSign, "utf8").digest("base64")
		return `SharedKey ${this.accountName}:${signature}`
	}

	async request(options: BlobRequestOptions): Promise<BlobResponse | null> {
		const query = options.query ?? {}
		const body = options.body
		const contentLength = body ? body.byteLength : 0
		const contentType = options.contentType ?? ""
		const contentMd5 = options.contentMd5 ?? ""

		let lastError: StorageError | null = null
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			const xms: Record<string, string> = {
				"x-ms-date": new Date().toUTCString(),
				"x-ms-version": BLOB_API_VERSION,
			}
			for (const [key, value] of Object.entries(options.headers ?? {})) {
				if (key.toLowerCase().startsWith("x-ms-")) xms[key.toLowerCase()] = value
			}
			const authorization = this.authorize({
				method: options.method,
				path: options.path,
				query,
				contentLength,
				contentType,
				contentMd5,
				xms,
			})
			const search = new URLSearchParams(query).toString()
			const url = `${this.endpoint}${this.encodePath(options.path)}${search ? `?${search}` : ""}`
			const headers: Record<string, string> = { ...xms, authorization }
			for (const [key, value] of Object.entries(options.headers ?? {})) {
				if (!key.toLowerCase().startsWith("x-ms-")) headers[key.toLowerCase()] = value
			}
			if (contentType) headers["content-type"] = contentType
			if (contentMd5) headers["content-md5"] = contentMd5

			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), this.timeoutMs)
			try {
				const response = await this.doFetch(url, {
					method: options.method,
					headers,
					body: body ? new Uint8Array(body) : undefined,
					signal: controller.signal,
				})
				if (response.ok) {
					if (options.raw) return { status: response.status, headers: response.headers, body: Buffer.alloc(0), response }
					const buffer =
						options.method === "HEAD"
							? Buffer.alloc(0)
							: Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))
					return { status: response.status, headers: response.headers, body: buffer }
				}
				if (response.status === 404 && options.allowNotFound) {
					await response.body?.cancel?.().catch(() => {})
					return null
				}
				const category = categoryForStatus(response.status)
				const requestId = response.headers?.get?.("x-ms-request-id") ?? undefined
				const errorCode = response.headers?.get?.("x-ms-error-code") ?? ""
				const detail = scrub(await response.text().catch(() => ""), this.secrets)
				lastError = new StorageError(
					`Azure Blob ${options.method} failed: HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}${detail ? ` - ${detail}` : ""}`,
					publicStatusForStorage(category),
					category,
					response.status,
					requestId,
				)
				if (!isRetryable(category) || attempt === this.maxRetries) throw lastError
				const retryAfter = Number(response.headers?.get?.("retry-after") ?? "")
				await this.doSleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500)
				continue
			} catch (error) {
				if (error instanceof StorageError) throw error
				const aborted = (error as Error)?.name === "AbortError"
				const category: StorageErrorCategory = aborted ? "timeout" : "network"
				lastError = new StorageError(
					aborted
						? `Azure Blob request timed out after ${this.timeoutMs}ms`
						: `Azure Blob storage is unreachable: ${scrub(String((error as Error)?.message ?? "unknown"), this.secrets)}`,
					publicStatusForStorage(category),
					category,
				)
				if (attempt === this.maxRetries) throw lastError
				await this.doSleep(2 ** attempt * 500)
				continue
			} finally {
				clearTimeout(timer)
			}
		}
		throw lastError ?? new StorageError("Azure Blob request failed", 502, "upstream")
	}

	private blobPath(blobName: string): string {
		return `/${this.container}/${blobName}`
	}

	/* ------------------------------ blobs -------------------------------- */

	/** Single-shot upload. Used for the small/medium documents NOVA accepts. */
	async putBlob(
		blobName: string,
		body: Buffer,
		options: {
			contentType?: string
			contentDisposition?: string
			cacheControl?: string
			metadata?: Record<string, string>
		} = {},
	): Promise<{ etag: string | null; size: number }> {
		const headers: Record<string, string> = { "x-ms-blob-type": "BlockBlob" }
		if (options.contentDisposition) headers["x-ms-blob-content-disposition"] = options.contentDisposition
		if (options.cacheControl) headers["x-ms-blob-cache-control"] = options.cacheControl
		for (const [key, value] of Object.entries(options.metadata ?? {})) {
			headers[`x-ms-meta-${key.toLowerCase()}`] = value
		}
		const result = await this.request({
			method: "PUT",
			path: this.blobPath(blobName),
			body,
			contentType: options.contentType || "application/octet-stream",
			// Transport integrity only; NOVA's canonical document hash stays in Neon.
			contentMd5: createHash("md5").update(body).digest("base64"),
			headers,
		})
		return { etag: result?.headers.get("etag") ?? null, size: body.byteLength }
	}

	/**
	 * Staged upload for larger payloads: 4 MiB blocks are read from the stream and
	 * committed with Put Block List, so the whole document is never held in memory.
	 */
	async putBlobFromStream(
		blobName: string,
		stream: Readable,
		options: {
			contentType?: string
			contentDisposition?: string
			cacheControl?: string
			metadata?: Record<string, string>
		} = {},
	): Promise<{ etag: string | null; size: number }> {
		const blockIds: string[] = []
		let pending: Buffer[] = []
		let pendingBytes = 0
		let total = 0

		const flush = async (): Promise<void> => {
			if (pendingBytes === 0) return
			const block = Buffer.concat(pending, pendingBytes)
			pending = []
			pendingBytes = 0
			const blockId = Buffer.from(`nova-${String(blockIds.length).padStart(8, "0")}`).toString("base64")
			blockIds.push(blockId)
			await this.request({
				method: "PUT",
				path: this.blobPath(blobName),
				query: { comp: "block", blockid: blockId },
				body: block,
				contentType: "application/octet-stream",
				contentMd5: createHash("md5").update(block).digest("base64"),
			})
			total += block.byteLength
		}

		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			pending.push(buffer)
			pendingBytes += buffer.byteLength
			if (pendingBytes >= BLOCK_SIZE_BYTES) await flush()
		}
		await flush()

		const headers: Record<string, string> = {}
		if (options.contentDisposition) headers["x-ms-blob-content-disposition"] = options.contentDisposition
		if (options.cacheControl) headers["x-ms-blob-cache-control"] = options.cacheControl
		for (const [key, value] of Object.entries(options.metadata ?? {})) {
			headers[`x-ms-meta-${key.toLowerCase()}`] = value
		}
		const xml =
			`<?xml version="1.0" encoding="utf-8"?><BlockList>` +
			blockIds.map((id) => `<Latest>${id}</Latest>`).join("") +
			`</BlockList>`
		const body = Buffer.from(xml, "utf8")
		const result = await this.request({
			method: "PUT",
			path: this.blobPath(blobName),
			query: { comp: "blocklist" },
			body,
			contentType: "application/xml",
			contentMd5: createHash("md5").update(body).digest("base64"),
			headers: { ...headers, "x-ms-blob-content-type": options.contentType || "application/octet-stream" },
		})
		return { etag: result?.headers.get("etag") ?? null, size: total }
	}

	async getBlob(blobName: string): Promise<{ body: Buffer; headers: Headers } | null> {
		const result = await this.request({ method: "GET", path: this.blobPath(blobName), allowNotFound: true })
		return result ? { body: result.body, headers: result.headers } : null
	}

	/** Streamed read, so a download never materialises the whole file in memory. */
	async getBlobStream(blobName: string): Promise<{ stream: Readable; headers: Headers } | null> {
		const result = await this.request({ method: "GET", path: this.blobPath(blobName), allowNotFound: true, raw: true })
		if (!result?.response?.body) return result ? { stream: Readable.from([]), headers: result.headers } : null
		return { stream: Readable.fromWeb(result.response.body as any), headers: result.headers }
	}

	async headBlob(blobName: string): Promise<Headers | null> {
		const result = await this.request({ method: "HEAD", path: this.blobPath(blobName), allowNotFound: true })
		return result ? result.headers : null
	}

	/** Idempotent: deleting an absent blob reports false rather than failing. */
	async deleteBlob(blobName: string): Promise<boolean> {
		const result = await this.request({ method: "DELETE", path: this.blobPath(blobName), allowNotFound: true })
		return result !== null
	}

	/* ---------------------------- container ------------------------------ */

	/** Returns container properties, or null when the container does not exist. */
	async getContainerProperties(): Promise<{ publicAccess: string | null; headers: Headers } | null> {
		const result = await this.request({
			method: "GET",
			path: `/${this.container}`,
			query: { restype: "container" },
			allowNotFound: true,
		})
		if (!result) return null
		return { publicAccess: result.headers.get("x-ms-blob-public-access"), headers: result.headers }
	}

	/**
	 * Explicit setup only (npm run storage:init). No public access header is sent,
	 * so the container is created private.
	 */
	async createContainer(): Promise<"created" | "exists"> {
		try {
			await this.request({ method: "PUT", path: `/${this.container}`, query: { restype: "container" } })
			return "created"
		} catch (error) {
			if (error instanceof StorageError && error.category === "conflict") return "exists"
			throw error
		}
	}
}
