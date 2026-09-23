/**
 * Phase 5 storage suite.
 *
 * Covers the storage abstraction end to end without touching a real Azure
 * account: the Blob provider is exercised against an injected `fetch`, so the
 * request shape, Shared Key header, retries, metadata and error scrubbing are
 * all asserted, while the local provider is exercised against a temp directory.
 *
 * Nothing here contacts Azure, and no real credential appears anywhere.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

import { ConfigError, getConfig, resetConfigCache } from "../backend/src/config/index.ts"
import {
	StorageError,
	buildObjectKey,
	contentTypeForExtension,
	isSafeObjectKey,
	keyBelongsToTenant,
	safeExtension,
} from "../backend/src/storage/base.ts"
import { LocalStorageProvider } from "../backend/src/storage/local.ts"
import { AzureBlobStorageProvider } from "../backend/src/storage/azure_blob.ts"
import { BlobClient, parseConnectionString } from "../backend/src/azure/blob.ts"
import type { PutOptions, PutResult, StorageProvider, ObjectMetadata } from "../backend/src/storage/base.ts"
import { DocumentService, safeDownloadName } from "../backend/src/documents/service.ts"
import { createEmbeddingProvider } from "../backend/src/embeddings/index.ts"
import { LocalVectorStore } from "../backend/src/retrieval/vector/local.ts"
import { freshDb, makeWorkspace } from "./helpers.ts"

/** Structurally valid, deliberately fake. "ZmFrZQ==" decodes to "fake". */
const TEST_CONNECTION_STRING =
	"DefaultEndpointsProtocol=https;AccountName=novastoragetest;AccountKey=ZmFrZS1hY2NvdW50LWtleS1mb3ItdGVzdHM=;EndpointSuffix=core.windows.net"
const TEST_ACCOUNT_KEY = "ZmFrZS1hY2NvdW50LWtleS1mb3ItdGVzdHM="

function tempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "nova-storage-"))
}

/* --------------------------- object key design ---------------------------- */

test("object keys are deterministic and carry tenant, document and version", () => {
	const key = buildObjectKey({ tenantId: "ten_1", documentId: "doc_2", versionId: "ver_3", filename: "policy.pdf" })
	assert.equal(key, "tenant/ten_1/document/doc_2/version/ver_3/original.pdf")
	assert.equal(key, buildObjectKey({ tenantId: "ten_1", documentId: "doc_2", versionId: "ver_3", filename: "policy.pdf" }))
	assert.ok(keyBelongsToTenant(key, "ten_1"))
	assert.ok(!keyBelongsToTenant(key, "ten_2"))
})

test("a new version always gets its own object, so history is never overwritten", () => {
	const v1 = buildObjectKey({ tenantId: "t", documentId: "d", versionId: "ver_1", filename: "a.pdf" })
	const v2 = buildObjectKey({ tenantId: "t", documentId: "d", versionId: "ver_2", filename: "a.pdf" })
	assert.notEqual(v1, v2)
})

test("hostile filenames never shape the object key", () => {
	for (const filename of ["../secret.pdf", "..\\secret.pdf", "/etc/passwd", "C:\\secret.txt", "tenant/../../other"]) {
		const key = buildObjectKey({ tenantId: "t1", documentId: "d1", versionId: "v1", filename })
		assert.ok(key.startsWith("tenant/t1/document/d1/version/v1/original"), key)
		assert.ok(!key.includes(".."))
		assert.ok(!key.includes("\\"))
		assert.ok(isSafeObjectKey(key))
	}
	// Only allowlisted extensions survive; anything else loses its suffix entirely.
	assert.equal(safeExtension("payload.exe"), "")
	assert.equal(safeExtension("../../evil.sh"), "")
	assert.equal(safeExtension("report.PDF"), ".pdf")
})

test("a client-supplied tenant id can never escape its prefix", () => {
	assert.throws(() => buildObjectKey({ tenantId: "../other", documentId: "d", versionId: "v", filename: "a.md" }), StorageError)
	assert.throws(() => buildObjectKey({ tenantId: "t/../x", documentId: "d", versionId: "v", filename: "a.md" }), StorageError)
})

test("malicious object keys are rejected structurally", () => {
	for (const key of [
		"../secret.pdf",
		"tenant/../../other/original.pdf",
		"/etc/passwd",
		"C:\\secret.txt",
		"tenant\\t1\\original.pdf",
		"tenant/t1/%2e%2e/original.pdf",
		"tenant/t1/",
		"",
	]) {
		assert.equal(isSafeObjectKey(key), false, key)
	}
	assert.equal(isSafeObjectKey("tenant/t1/document/d1/version/v1/original.pdf"), true)
})

/* --------------------------- local storage mode --------------------------- */

test("the local provider stores, reads, describes and deletes an object", async () => {
	const provider = new LocalStorageProvider(tempRoot())
	const key = buildObjectKey({ tenantId: "t1", documentId: "d1", versionId: "v1", filename: "leave.md" })

	const put = await provider.put(key, Buffer.from("hello nova"), { contentType: contentTypeForExtension(".md") })
	assert.equal(put.size, 10)
	assert.equal(await provider.exists(key), true)
	assert.equal((await provider.get(key)).toString("utf8"), "hello nova")

	const head = await provider.head(key)
	assert.equal(head?.size, 10)
	assert.match(head?.contentType ?? "", /markdown/)

	assert.equal(await provider.delete(key), true)
	assert.equal(await provider.exists(key), false)
	// Deleting twice is idempotent, not an error.
	assert.equal(await provider.delete(key), false)
	assert.equal(await provider.head(key), null)
})

test("the local provider streams and cannot be walked out of its root", async () => {
	const root = tempRoot()
	const provider = new LocalStorageProvider(root)
	const key = buildObjectKey({ tenantId: "t1", documentId: "d1", versionId: "v1", filename: "a.txt" })
	await provider.put(key, Readable.from([Buffer.from("streamed")]))
	const chunks: Buffer[] = []
	for await (const chunk of await provider.getStream(key)) chunks.push(chunk as Buffer)
	assert.equal(Buffer.concat(chunks).toString("utf8"), "streamed")

	for (const bad of ["../escape.txt", "tenant/../../escape.txt", "/etc/passwd"]) {
		await assert.rejects(() => provider.get(bad), StorageError)
		await assert.rejects(() => provider.put(bad, Buffer.from("x")), StorageError)
	}
	assert.equal(fs.existsSync(path.join(path.dirname(root), "escape.txt")), false)
})

test("reading a missing local object is a not_found storage error", async () => {
	const provider = new LocalStorageProvider(tempRoot())
	await assert.rejects(
		() => provider.get("tenant/t1/document/d1/version/v1/original.txt"),
		(error: StorageError) => error.category === "not_found" && error.statusCode === 404,
	)
})

/* ------------------------------ configuration ----------------------------- */

const STORAGE_ENV_KEYS = [
	"APP_MODE",
	"AI_MODE",
	"KNOWLEDGE_MODE",
	"AUTH_MODE",
	"ACTION_MODE",
	"VECTOR_STORE",
	"STORAGE_MODE",
	"DATABASE_URL",
	"AZURE_STORAGE_CONNECTION_STRING",
	"AZURE_STORAGE_CONTAINER",
	"AZURE_STORAGE_ACCOUNT",
	"MAX_DOCUMENT_SIZE_BYTES",
] as const

function withEnv<T>(env: Partial<Record<(typeof STORAGE_ENV_KEYS)[number], string>>, fn: () => T): T {
	const previous = new Map<string, string | undefined>()
	for (const key of STORAGE_ENV_KEYS) {
		previous.set(key, process.env[key])
		delete process.env[key]
	}
	for (const [key, value] of Object.entries(env)) process.env[key] = value
	resetConfigCache()
	try {
		return fn()
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		resetConfigCache()
	}
}

const NEON_URL = "postgresql://user:pw@example.neon.tech/nova"

test("storage defaults to local and materialises no azure settings", () => {
	withEnv({}, () => {
		const config = getConfig()
		assert.equal(config.modes.storageMode, "local")
		assert.equal(config.azure, null)
		assert.equal(config.isFullyLocal, true)
	})
})

test("azure blob storage requires its connection string and container", () => {
	withEnv({ STORAGE_MODE: "azure_blob", DATABASE_URL: NEON_URL, AZURE_STORAGE_CONTAINER: "documents" }, () => {
		assert.throws(() => getConfig(), ConfigError)
	})
	withEnv(
		{ STORAGE_MODE: "azure_blob", DATABASE_URL: NEON_URL, AZURE_STORAGE_CONNECTION_STRING: TEST_CONNECTION_STRING },
		() => {
			assert.throws(() => getConfig(), ConfigError)
		},
	)
})

test("selecting azure blob storage puts the whole application in azure mode", () => {
	withEnv(
		{
			STORAGE_MODE: "azure_blob",
			DATABASE_URL: NEON_URL,
			AZURE_STORAGE_CONNECTION_STRING: TEST_CONNECTION_STRING,
			AZURE_STORAGE_CONTAINER: "documents",
			AZURE_STORAGE_ACCOUNT: "novastoragetest",
		},
		() => {
			const config = getConfig()
			assert.equal(config.appMode, "azure")
			assert.equal(config.isFullyLocal, false)
			assert.equal(config.azure?.storage.container, "documents")
			assert.equal(config.azure?.storage.connectionString, TEST_CONNECTION_STRING)
		},
	)
})

test("an unsupported STORAGE_MODE fails instead of silently falling back to local", () => {
	withEnv({ STORAGE_MODE: "azure" }, () => assert.throws(() => getConfig(), ConfigError))
	withEnv({ STORAGE_MODE: "blob" }, () => assert.throws(() => getConfig(), ConfigError))
})

test("the maximum document size is configuration, not a hard-coded constant", () => {
	withEnv({ MAX_DOCUMENT_SIZE_BYTES: "1048576" }, () => {
		assert.equal(getConfig().documents.maxBytes, 1_048_576)
	})
	withEnv({}, () => assert.equal(getConfig().documents.maxBytes, 15 * 1024 * 1024))
})

/* --------------------------- azure blob provider -------------------------- */

type Call = { url: string; method: string; headers: Record<string, string>; body?: Buffer }

/** Records every request and replies from a queue of canned responses. */
function fakeAzure(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
	const calls: Call[] = []
	const queue = [...responses]
	const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
		const headers: Record<string, string> = {}
		for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
			headers[key.toLowerCase()] = value
		}
		calls.push({
			url: String(url),
			method: init.method ?? "GET",
			headers,
			body: init.body ? Buffer.from(init.body as Uint8Array) : undefined,
		})
		const next = queue.shift() ?? { status: 200 }
		return new Response(next.body ?? "", { status: next.status, headers: next.headers })
	}) as unknown as typeof fetch
	return { calls, fetchImpl }
}

function azureProvider(
	responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
	options: { maxRetries?: number } = {},
) {
	const { calls, fetchImpl } = fakeAzure(responses)
	const client = new BlobClient({
		connectionString: TEST_CONNECTION_STRING,
		container: "documents",
		fetchImpl,
		sleepImpl: async () => {},
		maxRetries: options.maxRetries ?? 2,
	})
	return { provider: new AzureBlobStorageProvider(client), calls, client }
}

test("a connection string is parsed into an https endpoint and never kept as text", () => {
	const credential = parseConnectionString(TEST_CONNECTION_STRING)
	assert.equal(credential.accountName, "novastoragetest")
	assert.equal(credential.endpoint, "https://novastoragetest.blob.core.windows.net")
	assert.ok(Buffer.isBuffer(credential.accountKey))
	assert.throws(() => parseConnectionString(""), StorageError)
	assert.throws(() => parseConnectionString("AccountName=only"), StorageError)
})

test("a mismatched AZURE_STORAGE_ACCOUNT is refused rather than guessed", () => {
	assert.throws(
		() => new BlobClient({ connectionString: TEST_CONNECTION_STRING, container: "documents", expectedAccount: "someoneelse" }),
		StorageError,
	)
})

test("uploading signs the request, sets the blob type, content type and metadata", async () => {
	const { provider, calls } = azureProvider([{ status: 201, headers: { etag: '"0x1"' } }])
	const key = buildObjectKey({ tenantId: "t1", documentId: "d1", versionId: "v1", filename: "policy.pdf" })
	const result = await provider.put(key, Buffer.from("%PDF-1.4 test"), {
		contentType: "application/pdf",
		contentDisposition: 'attachment; filename="policy.pdf"',
		metadata: { tenantid: "t1", documentid: "d1", versionid: "v1" },
	})

	assert.equal(result.size, 13)
	assert.equal(calls.length, 1)
	const call = calls[0]
	assert.equal(call.method, "PUT")
	assert.equal(call.url, `https://novastoragetest.blob.core.windows.net/documents/${key}`)
	assert.equal(call.headers["x-ms-blob-type"], "BlockBlob")
	assert.equal(call.headers["content-type"], "application/pdf")
	assert.equal(call.headers["x-ms-meta-tenantid"], "t1")
	assert.equal(call.headers["x-ms-meta-versionid"], "v1")
	assert.match(call.headers["authorization"], /^SharedKey novastoragetest:/)
	// The signature is derived from the key; the key itself is never transmitted.
	assert.ok(!call.headers["authorization"].includes(TEST_ACCOUNT_KEY))
	assert.ok(!JSON.stringify(call.headers).includes(TEST_CONNECTION_STRING))
})

test("reading, existence and metadata map onto the blob REST surface", async () => {
	const download = azureProvider([{ status: 200, body: "stored bytes", headers: { "content-type": "text/plain" } }])
	assert.equal((await download.provider.get("tenant/t1/document/d1/version/v1/original.txt")).toString("utf8"), "stored bytes")
	assert.equal(download.calls[0].method, "GET")

	const head = azureProvider([
		{
			status: 200,
			headers: {
				"content-length": "42",
				"content-type": "application/pdf",
				"last-modified": "Tue, 01 Sep 2026 10:00:00 GMT",
				"x-ms-meta-tenantid": "t1",
			},
		},
	])
	const metadata = (await head.provider.head("tenant/t1/document/d1/version/v1/original.pdf")) as ObjectMetadata
	assert.equal(metadata.size, 42)
	assert.equal(metadata.contentType, "application/pdf")
	assert.equal(metadata.metadata.tenantid, "t1")
	assert.equal(head.calls[0].method, "HEAD")

	const missing = azureProvider([{ status: 404 }])
	assert.equal(await missing.provider.exists("tenant/t1/document/d1/version/v1/original.pdf"), false)
})

test("deleting is idempotent and a missing blob is not an error", async () => {
	const present = azureProvider([{ status: 202 }])
	assert.equal(await present.provider.delete("tenant/t1/document/d1/version/v1/original.pdf"), true)
	const absent = azureProvider([{ status: 404 }])
	assert.equal(await absent.provider.delete("tenant/t1/document/d1/version/v1/original.pdf"), false)
})

test("transient failures are retried, permanent ones are not", async () => {
	const transient = azureProvider([{ status: 503 }, { status: 201 }])
	await transient.provider.put("tenant/t1/document/d1/version/v1/original.txt", Buffer.from("x"))
	assert.equal(transient.calls.length, 2, "a 503 should be retried once")

	const permanent = azureProvider([{ status: 403, body: "<Error>AuthorizationFailure</Error>" }])
	await assert.rejects(
		() => permanent.provider.put("tenant/t1/document/d1/version/v1/original.txt", Buffer.from("x")),
		(error: StorageError) => error.category === "auth",
	)
	assert.equal(permanent.calls.length, 1, "an authorization failure must not be retried")
})

test("storage errors never carry the connection string or account key outward", async () => {
	const { provider } = azureProvider([
		{ status: 403, body: `<Error>AccountKey=${TEST_ACCOUNT_KEY};DefaultEndpointsProtocol=https</Error>` },
	])
	await assert.rejects(
		() => provider.get("tenant/t1/document/d1/version/v1/original.txt"),
		(error: StorageError) => {
			const text = `${error.message} ${error.diagnostic} ${error.publicMessage}`
			assert.ok(!text.includes(TEST_ACCOUNT_KEY), "the account key leaked into an error")
			assert.ok(!text.includes(TEST_CONNECTION_STRING))
			assert.match(error.publicMessage, /unavailable|retry/i)
			return true
		},
	)
})

test("the azure provider refuses client-shaped object keys before any request", async () => {
	const { provider, calls } = azureProvider([{ status: 201 }])
	for (const bad of ["../secret.pdf", "/etc/passwd", "tenant/t1/../../other/original.pdf"]) {
		await assert.rejects(() => provider.get(bad), StorageError)
		await assert.rejects(() => provider.delete(bad), StorageError)
	}
	assert.equal(calls.length, 0, "an invalid key must never reach Azure")
})

test("the provider descriptor is safe to log", () => {
	const { provider } = azureProvider([])
	assert.equal(provider.describe(), "https://novastoragetest.blob.core.windows.net/documents")
	assert.ok(!provider.describe().includes(TEST_ACCOUNT_KEY))
})

/* ------------------------- ingestion + lifecycle -------------------------- */

/** In-memory provider so the pipeline can be driven without any filesystem or Azure. */
class MemoryStorageProvider implements StorageProvider {
	readonly name = "memory"
	readonly mode = "local" as const
	readonly container = "memory"
	readonly objects = new Map<string, { body: Buffer; contentType: string; metadata: Record<string, string> }>()
	failNextPut = false
	deletes: string[] = []

	describe(): string {
		return "memory://documents"
	}
	async put(key: string, body: Buffer | Readable, options: PutOptions = {}): Promise<PutResult> {
		if (this.failNextPut) {
			this.failNextPut = false
			throw new StorageError("simulated upload failure", 502, "upstream")
		}
		const buffer = Buffer.isBuffer(body) ? body : Buffer.concat([])
		this.objects.set(key, {
			body: buffer,
			contentType: options.contentType ?? "application/octet-stream",
			metadata: options.metadata ?? {},
		})
		return { key, size: buffer.byteLength, contentType: options.contentType ?? "application/octet-stream" }
	}
	async get(key: string): Promise<Buffer> {
		const object = this.objects.get(key)
		if (!object) throw new StorageError("missing", 404, "not_found")
		return object.body
	}
	async getStream(key: string): Promise<Readable> {
		return Readable.from([await this.get(key)])
	}
	async exists(key: string): Promise<boolean> {
		return this.objects.has(key)
	}
	async head(key: string): Promise<ObjectMetadata | null> {
		const object = this.objects.get(key)
		if (!object) return null
		return { key, size: object.body.byteLength, contentType: object.contentType, lastModified: null, metadata: object.metadata }
	}
	async delete(key: string): Promise<boolean> {
		this.deletes.push(key)
		return this.objects.delete(key)
	}
}

function documentService(db: ReturnType<typeof freshDb>, storage: StorageProvider) {
	return new DocumentService(db, createEmbeddingProvider(), new LocalVectorStore(db), storage)
}

function workspace(db: ReturnType<typeof freshDb>, name: string) {
	return makeWorkspace(db, {
		name,
		departments: ["Human Resources", "Operations"],
		users: [
			{ name: "Admin User", email: "admin@test.example", roleKey: "ADMIN", department: "Operations" },
			{ name: "Basic User", email: "basic@test.example", roleKey: "EMPLOYEE", department: "Operations" },
		],
	})
}

const POLICY = `Leave Policy
Department: Human Resources
Classification: internal

Employees accrue 1.5 days of paid leave per month.
`

test("ingestion uploads the original and records the object key in the database", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Storage Co")

	const result = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: "Admin User",
	})

	const expectedKey = `tenant/${ws.tenant.id}/document/${result.document.id}/version/${result.version.id}/original.md`
	assert.equal(result.version.storageKey, expectedKey)
	assert.equal(result.version.storageProvider, "local")
	assert.equal(result.version.originalFilename, "leave_policy.md")
	assert.match(result.version.mimeType, /markdown/)
	assert.equal(result.version.sizeBytes, Buffer.byteLength(POLICY))
	assert.equal(result.version.ingestStatus, "indexed")
	assert.equal(storage.objects.get(expectedKey)?.body.toString("utf8"), POLICY)
	// Operational metadata only: no ACL, classification or user identity.
	assert.deepEqual(Object.keys(storage.objects.get(expectedKey)!.metadata).sort(), ["documentid", "tenantid", "versionid"])
	// The database holds the reference, never the binary.
	const row = db.get<any>("SELECT * FROM document_versions WHERE id = ?", result.version.id)
	assert.equal(row.storage_key, expectedKey)
	assert.equal(typeof row.checksum, "string")
})

test("a second version creates a second object and the first one is retained", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Versioned Co")

	const first = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: "Admin User",
		version: "2026.1",
	})
	const second = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(`${POLICY}\nUpdated for 2026.2.\n`, "utf8"),
		uploadedBy: "Admin User",
		version: "2026.2",
	})

	assert.notEqual(first.version.storageKey, second.version.storageKey)
	assert.equal(storage.objects.size, 2)
	assert.ok(await storage.exists(first.version.storageKey!))

	// Deactivation is a lifecycle change: the source file must survive it.
	await documents.deactivateVersion(ws.tenant.id, second.document.id, first.version.id)
	assert.ok(await storage.exists(first.version.storageKey!), "deactivation must not delete the stored original")
	assert.deepEqual(storage.deletes, [])
})

test("a storage failure never marks a document ready and leaves no orphan object", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Failing Co")

	storage.failNextPut = true
	await assert.rejects(
		() =>
			documents.ingest({
				tenantId: ws.tenant.id,
				filename: "leave_policy.md",
				buffer: Buffer.from(POLICY, "utf8"),
				uploadedBy: "Admin User",
			}),
		/could not be stored/,
	)

	const document = documents.listDocuments(ws.tenant.id)[0]
	const version = document.versions[0]
	assert.equal(version.ingestStatus, "failed")
	assert.equal(version.status, "inactive")
	assert.equal(storage.objects.size, 0)
	assert.equal(storage.deletes.length, 1, "the orphaned object must be cleaned up")
	assert.equal(db.get<any>("SELECT COUNT(*) AS n FROM document_chunks")?.n ?? 0, 0)

	// The retry succeeds and replaces the abandoned attempt.
	const retry = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: "Admin User",
	})
	assert.equal(retry.version.ingestStatus, "indexed")
	assert.ok(await storage.exists(retry.version.storageKey!))
})

test("deleting a document removes its stored originals", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Delete Co")

	const result = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: "Admin User",
	})
	await documents.deleteDocument(ws.tenant.id, result.document.id)
	assert.equal(storage.objects.size, 0)
	assert.equal(await storage.exists(result.version.storageKey!), false)
	assert.equal(db.get<any>("SELECT COUNT(*) AS n FROM document_versions")?.n ?? 0, 0)
})

test("re-ingesting identical bytes reuses the version and re-embeds nothing", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Idempotent Co")

	const first = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: "Admin User",
	})
	const again = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: "Admin User",
	})
	assert.equal(again.version.id, first.version.id)
	assert.equal(storage.objects.size, 1)
	assert.match(again.warnings.join(" "), /already ingested/)
})

/* ----------------------------- download security -------------------------- */

test("an authorized download streams the stored original", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Download Co")
	const admin = ws.actor("admin@test.example")

	const result = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: admin.user.name,
	})
	const file = await documents.readVersionFile(admin.scope, ws.tenant.id, result.document.id, result.version.id)
	const chunks: Buffer[] = []
	for await (const chunk of file.stream) chunks.push(chunk as Buffer)
	assert.equal(Buffer.concat(chunks).toString("utf8"), POLICY)
	assert.equal(file.filename, "leave_policy.md")
	assert.match(file.contentType, /markdown/)
})

test("tenant A cannot download tenant B's document or version", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const a = workspace(db, "Alpha Industries")
	const b = workspace(db, "Beta Logistics")

	const owned = await documents.ingest({
		tenantId: b.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: "Admin User",
	})

	const intruder = a.actor("admin@test.example")
	// Using the victim's tenant id directly.
	await assert.rejects(
		() => documents.readVersionFile(intruder.scope, b.tenant.id, owned.document.id, owned.version.id),
		/not found/i,
	)
	// Using their own tenant id with the victim's identifiers.
	await assert.rejects(
		() => documents.readVersionFile(intruder.scope, a.tenant.id, owned.document.id, owned.version.id),
		/not found/i,
	)
	// The object itself is still intact: access was denied, not destroyed.
	assert.ok(await storage.exists(owned.version.storageKey!))
})

test("a user without clearance is refused the file with the same 404 as a missing one", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Clearance Co")

	const confidential = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "salary_bands.md",
		buffer: Buffer.from("Salary Bands\nDepartment: Human Resources\nClassification: confidential\n\nBand E3: 1,800,000.\n", "utf8"),
		uploadedBy: "Admin User",
	})
	const basic = ws.actor("basic@test.example")
	await assert.rejects(
		() => documents.readVersionFile(basic.scope, ws.tenant.id, confidential.document.id, confidential.version.id),
		/not found/i,
	)
})

test("a tampered object key is refused rather than followed", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Tamper Co")
	const admin = ws.actor("admin@test.example")

	const result = await documents.ingest({
		tenantId: ws.tenant.id,
		filename: "leave_policy.md",
		buffer: Buffer.from(POLICY, "utf8"),
		uploadedBy: admin.user.name,
	})
	// Simulate a row whose storage key points somewhere else entirely.
	db.run("UPDATE document_versions SET storage_key = ? WHERE id = ?", "tenant/other/document/x/version/y/original.md", result.version.id)
	await assert.rejects(
		() => documents.readVersionFile(admin.scope, ws.tenant.id, result.document.id, result.version.id),
		/unavailable/i,
	)
})

/* ------------------------------- validation ------------------------------- */

test("unsupported and path-shaped filenames are rejected before storage is touched", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Validation Co")

	for (const filename of ["payload.exe", "../secret.pdf", "..\\secret.pdf", "/etc/passwd", "C:\\secret.txt"]) {
		await assert.rejects(() =>
			documents.ingest({
				tenantId: ws.tenant.id,
				filename,
				buffer: Buffer.from("content", "utf8"),
				uploadedBy: "Admin User",
			}),
		)
	}
	assert.equal(storage.objects.size, 0)
})

test("a mislabelled content type is refused and oversize files never reach storage", async () => {
	const db = freshDb()
	const storage = new MemoryStorageProvider()
	const documents = documentService(db, storage)
	const ws = workspace(db, "Limits Co")

	await assert.rejects(
		() =>
			documents.ingest({
				tenantId: ws.tenant.id,
				filename: "leave_policy.md",
				buffer: Buffer.from(POLICY, "utf8"),
				uploadedBy: "Admin User",
				mimeType: "application/x-msdownload",
			}),
		/content type/i,
	)

	const previous = process.env.MAX_DOCUMENT_SIZE_BYTES
	process.env.MAX_DOCUMENT_SIZE_BYTES = "64"
	resetConfigCache()
	try {
		await assert.rejects(
			() =>
				documents.ingest({
					tenantId: ws.tenant.id,
					filename: "leave_policy.md",
					buffer: Buffer.from(POLICY, "utf8"),
					uploadedBy: "Admin User",
				}),
			/upload limit/i,
		)
	} finally {
		if (previous === undefined) delete process.env.MAX_DOCUMENT_SIZE_BYTES
		else process.env.MAX_DOCUMENT_SIZE_BYTES = previous
		resetConfigCache()
	}
	assert.equal(storage.objects.size, 0)
})

test("download filenames are sanitised for the response header", () => {
	assert.equal(safeDownloadName("../../etc/passwd"), "passwd")
	assert.equal(safeDownloadName(`evil";rm -rf.pdf`), "evil__rm -rf.pdf")
	assert.equal(safeDownloadName(""), "document")
})
