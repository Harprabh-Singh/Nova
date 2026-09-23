/**
 * Document + version + chunk persistence and the ingestion pipeline:
 *   upload -> validate -> extract -> detect metadata -> chunk -> embed ->
 *   index -> store metadata -> searchable
 *
 * Nothing here knows about any specific company: every call is tenant-scoped.
 */
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import type { Database } from "../db/index.ts"
import type {
	Classification,
	DocumentVersion,
	IngestStatus,
	KnowledgeDocument,
} from "../models/types.ts"
import { CLASSIFICATIONS, CLASSIFICATION_LEVEL } from "../models/types.ts"
import { chunkText, firstHeading } from "./chunk.ts"
import { extractText, extensionOf, ExtractionError, UnsupportedFileError } from "./extract.ts"
import { detectInjection } from "./injection.ts"
import type { EmbeddingProvider } from "../embeddings/base.ts"
import type { VectorStore } from "../retrieval/vector/base.ts"
import { searchDocumentKey } from "../retrieval/vector/azure-index.ts"
import { floatsToBuffer } from "../embeddings/base.ts"
import { getConfig } from "../config/index.ts"
import { log, recordActivity } from "../observability/logger.ts"
import { tokenize } from "../embeddings/local.ts"
import type { AccessScope } from "../authorization/policy.ts"
import { decideDocumentAccess } from "../authorization/policy.ts"
import { createStorageProvider } from "../storage/index.ts"
import {
	StorageError,
	buildObjectKey,
	contentTypeForExtension,
	safeExtension,
	type StorageProvider,
} from "../storage/base.ts"

/** Default ceiling; MAX_DOCUMENT_SIZE_BYTES overrides it without touching code. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

export function maxUploadBytes(): number {
	const configured = getConfig().documents?.maxBytes
	return Number.isFinite(configured) && (configured as number) > 0 ? (configured as number) : MAX_UPLOAD_BYTES
}

/** The document types NOVA accepts, mirroring documents/extract.ts. */
export const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt", ".docx", ".pdf"] as const

/**
 * Content types a browser may legitimately send for the supported extensions.
 * A client-declared type is never trusted on its own: it only has to be
 * *consistent* with the extension, and the extension decides the stored type.
 */
const ACCEPTABLE_CLIENT_TYPES: Record<string, string[]> = {
	".md": ["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"],
	".markdown": ["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"],
	".txt": ["text/plain", "application/octet-stream"],
	".docx": [
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/zip",
		"application/octet-stream",
	],
	".pdf": ["application/pdf", "application/octet-stream"],
}

/** RFC 6266-safe filename for Content-Disposition. Never used as an object key. */
export function safeDownloadName(filename: string): string {
	const base = (String(filename ?? "").replace(/\\/g, "/").split("/").pop() ?? "document").trim()
	const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120)
	return cleaned || "document"
}

export class DocumentError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message)
		this.name = "DocumentError"
	}
}

export type IngestInput = {
	tenantId: string
	filename: string
	buffer: Buffer
	uploadedBy: string
	/** Client-declared content type, if any. Validated, never trusted alone. */
	mimeType?: string
	title?: string
	department?: string
	category?: string
	classification?: Classification
	version?: string
	effectiveDate?: string
	allowedRoles?: string[]
	allowedUsers?: string[]
	/** When true, a new version supersedes the previous active version. */
	activate?: boolean
}

export type IngestResult = {
	document: KnowledgeDocument
	version: DocumentVersion
	chunkCount: number
	warnings: string[]
	injectionFlags: string[]
}

function rowToDocument(r: any): KnowledgeDocument {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		title: r.title,
		filename: r.filename,
		department: r.department,
		category: r.category,
		classification: r.classification,
		sourceType: r.source_type,
		status: r.status,
		allowedRoles: JSON.parse(r.allowed_roles_json || "[]"),
		allowedUsers: JSON.parse(r.allowed_users_json || "[]"),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}
}

function rowToVersion(r: any): DocumentVersion {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		documentId: r.document_id,
		version: r.version,
		status: r.status,
		effectiveDate: r.effective_date,
		uploadedAt: r.uploaded_at,
		uploadedBy: r.uploaded_by,
		storagePath: r.storage_path,
		storageProvider: r.storage_provider ?? "local",
		storageContainer: r.storage_container ?? "",
		storageKey: r.storage_key ?? null,
		originalFilename: r.original_filename ?? "",
		mimeType: r.mime_type ?? "",
		sizeBytes: Number(r.size_bytes ?? 0),
		checksum: r.checksum,
		charCount: r.char_count,
		chunkCount: r.chunk_count,
		ingestStatus: r.ingest_status,
		ingestError: r.ingest_error,
	}
}

/** Heuristic metadata detection from the document body (overridable by the admin). */
/**
 * Many enterprise documents open with a bare title line before any heading or
 * `Key: value` front matter. Treat that first line as the document title.
 */
function leadingTitleLine(head: string): string | undefined {
	for (const raw of head.split(/\r?\n/).slice(0, 5)) {
		const line = raw.trim()
		if (!line) continue
		if (line.startsWith("#")) return line.replace(/^#+\s*/, "").trim() || undefined
		// A front-matter pair or an over-long sentence is not a title.
		if (/^[A-Za-z][A-Za-z &/_-]{2,30}:\s/.test(line)) return undefined
		if (line.length < 3 || line.length > 120 || line.endsWith(".")) return undefined
		return line
	}
	return undefined
}

export function detectMetadata(text: string, filename: string) {
	const head = text.slice(0, 4000)
	const version = /version[:\s]+([0-9]{4}\.[0-9]+|v?[0-9]+\.[0-9]+)/i.exec(head)?.[1]
	const effectiveDate = /effective(?:\s+date)?[:\s]+([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(head)?.[1]
	const department = /department[:\s]+([A-Za-z &]{3,40})/i.exec(head)?.[1]?.trim()
	const classificationMatch = /classification[:\s]+(public|internal|confidential|restricted)/i.exec(head)?.[1]
	const category = /category[:\s]+([A-Za-z &/\-]{3,40})/i.exec(head)?.[1]?.trim()
	const title =
		/^title[:\s]+(.{3,120})$/im.exec(head)?.[1]?.trim() ??
		leadingTitleLine(head) ??
		firstHeading(text) ??
		path.basename(filename, extensionOf(filename)).replace(/[_-]+/g, " ")
	return {
		title: title.replace(/^#+\s*/, "").trim(),
		version,
		effectiveDate,
		department,
		category,
		classification: classificationMatch?.toLowerCase() as Classification | undefined,
	}
}

function nextVersionLabel(previous?: string): string {
	const year = new Date().getFullYear()
	if (!previous) return `${year}.1`
	const match = /^(\d{4})\.(\d+)$/.exec(previous)
	if (match) return `${match[1]}.${Number(match[2]) + 1}`
	return `${year}.1`
}

export class DocumentService {
	/**
	 * `storage` is the only route to a document's bytes. In local/demo mode it is
	 * the filesystem provider; in production/Azure mode it is Azure Blob Storage.
	 * Nothing in this class knows which one it holds.
	 */
	constructor(
		private readonly db: Database,
		private readonly embeddings: EmbeddingProvider,
		private readonly vectorStore: VectorStore,
		private readonly storage: StorageProvider = createStorageProvider(),
	) {}

	/** Safe descriptor for diagnostics. Never a credential. */
	get storageDescriptor(): string {
		return this.storage.describe()
	}

	/* ----------------------------- queries ------------------------------- */

	listDocuments(tenantId: string): Array<KnowledgeDocument & { versions: DocumentVersion[] }> {
		const documents = this.db
			.all(`SELECT * FROM documents WHERE tenant_id = ? ORDER BY department, title`, tenantId)
			.map(rowToDocument)
		return documents.map((document) => ({ ...document, versions: this.listVersions(tenantId, document.id) }))
	}

	getDocument(tenantId: string, documentId: string): KnowledgeDocument | null {
		const row = this.db.get(`SELECT * FROM documents WHERE tenant_id = ? AND id = ?`, tenantId, documentId)
		return row ? rowToDocument(row) : null
	}

	listVersions(tenantId: string, documentId: string): DocumentVersion[] {
		return this.db
			.all(
				`SELECT * FROM document_versions WHERE tenant_id = ? AND document_id = ? ORDER BY uploaded_at DESC`,
				tenantId,
				documentId,
			)
			.map(rowToVersion)
	}

	activeVersion(tenantId: string, documentId: string): DocumentVersion | null {
		const row = this.db.get(
			`SELECT * FROM document_versions WHERE tenant_id = ? AND document_id = ? AND status = 'active' ORDER BY uploaded_at DESC LIMIT 1`,
			tenantId,
			documentId,
		)
		return row ? rowToVersion(row) : null
	}

	/* ---------------------------- ingestion ------------------------------ */

	async ingest(input: IngestInput): Promise<IngestResult> {
		const config = getConfig()

		// 1. VALIDATE (before a single byte reaches storage)
		if (!input.filename) throw new DocumentError("A filename is required.")
		// A filename is metadata, never a path. Traversal attempts are rejected
		// outright rather than silently sanitised, and the object key is built
		// from database identifiers regardless.
		if (/[/\\]/.test(input.filename) || input.filename.includes("..") || /[\x00-\x1f]/.test(input.filename)) {
			throw new DocumentError("The filename must not contain a path.")
		}
		if (input.filename.length > 255) throw new DocumentError("The filename is too long.")
		const extension = extensionOf(input.filename)
		if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) {
			throw new DocumentError(
				`Unsupported file type "${extension || "(none)"}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
				415,
			)
		}
		// The client-declared MIME type is only checked for consistency: the
		// extension decides the stored content type, so a mislabelled executable
		// cannot enter as an "enterprise document".
		const declaredType = (input.mimeType ?? "").split(";")[0].trim().toLowerCase()
		if (declaredType && !(ACCEPTABLE_CLIENT_TYPES[extension] ?? []).includes(declaredType)) {
			throw new DocumentError(`The declared content type "${declaredType}" does not match a ${extension} document.`, 415)
		}
		if (input.buffer.byteLength === 0) throw new DocumentError("The uploaded file is empty.")
		const sizeLimit = maxUploadBytes()
		if (input.buffer.byteLength > sizeLimit) {
			throw new DocumentError(`File exceeds the ${Math.round(sizeLimit / 1024 / 1024)} MB upload limit.`)
		}
		if (input.classification && !CLASSIFICATIONS.includes(input.classification)) {
			throw new DocumentError(`Unknown classification "${input.classification}".`)
		}

		// 2. EXTRACT
		let extracted
		try {
			extracted = extractText(input.filename, input.buffer)
		} catch (error) {
			if (error instanceof UnsupportedFileError || error instanceof ExtractionError) {
				throw new DocumentError(error.message, 415)
			}
			throw new DocumentError("The file could not be processed.", 422)
		}

		// 3. DETECT METADATA (explicit admin values always win)
		const detected = detectMetadata(extracted.text, input.filename)
		const title = input.title?.trim() || detected.title
		const department = input.department?.trim() || detected.department || "General"
		const category = input.category?.trim() || detected.category || "policy"
		const classification = input.classification || detected.classification || "internal"

		const now = new Date().toISOString()
		const checksum = createHash("sha256").update(input.buffer).digest("hex")

		// 4. UPSERT DOCUMENT (filename is the per-tenant document key)
		const existing = this.db.get(
			`SELECT * FROM documents WHERE tenant_id = ? AND filename = ?`,
			input.tenantId,
			input.filename,
		)
		const documentId: string = existing?.id ?? `doc_${randomUUID()}`
		if (existing) {
			this.db.run(
				`UPDATE documents SET title = ?, department = ?, category = ?, classification = ?,
					source_type = ?, allowed_roles_json = ?, allowed_users_json = ?, updated_at = ?, status = 'active'
				 WHERE id = ? AND tenant_id = ?`,
				title,
				department,
				category,
				classification,
				extracted.sourceType,
				JSON.stringify(input.allowedRoles ?? JSON.parse(existing.allowed_roles_json || "[]")),
				JSON.stringify(input.allowedUsers ?? JSON.parse(existing.allowed_users_json || "[]")),
				now,
				documentId,
				input.tenantId,
			)
		} else {
			this.db.run(
				`INSERT INTO documents (id, tenant_id, title, filename, department, category, classification,
					source_type, status, allowed_roles_json, allowed_users_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
				documentId,
				input.tenantId,
				title,
				input.filename,
				department,
				category,
				classification,
				extracted.sourceType,
				JSON.stringify(input.allowedRoles ?? []),
				JSON.stringify(input.allowedUsers ?? []),
				now,
				now,
			)
		}

		// 5. STORE THE FILE through the storage provider (local disk or Azure Blob)
		const previousVersions = this.listVersions(input.tenantId, documentId)
		const versionLabel =
			input.version?.trim() ||
			detected.version ||
			nextVersionLabel(previousVersions.find((v) => v.status === "active")?.version ?? previousVersions[0]?.version)

		// Idempotent re-ingestion: identical bytes that were already indexed are
		// never processed twice, which keeps `seed-demo` safe to re-run and
		// guarantees no redundant embedding call.
		const sameChecksum = previousVersions.find((v) => v.checksum === checksum && v.ingestStatus === "indexed")
		if (sameChecksum) {
			return {
				document: this.getDocument(input.tenantId, documentId)!,
				version: sameChecksum,
				chunkCount: sameChecksum.chunkCount,
				warnings: ["This exact file was already ingested; the existing version was reused."],
				injectionFlags: [],
			}
		}

		// An earlier attempt at these exact bytes that never reached `indexed` is
		// not a reusable version: it is recoverable state from a failed upload or
		// a failed indexing pass. Discard it (rows + any object it left behind)
		// and retry cleanly, so a retry can always succeed.
		const abandoned = previousVersions.filter((v) => v.checksum === checksum && v.ingestStatus !== "indexed")
		for (const version of abandoned) await this.discardVersion(input.tenantId, version)
		const liveVersions = previousVersions.filter((v) => !abandoned.includes(v))

		if (liveVersions.some((v) => v.version === versionLabel)) {
			throw new DocumentError(`Version ${versionLabel} already exists for this document.`, 409)
		}

		// Each version gets its OWN deterministic object. A new version never
		// overwrites the previous version's file, so history stays recoverable.
		const versionId = `ver_${randomUUID()}`
		const storageKey = buildObjectKey({
			tenantId: input.tenantId,
			documentId,
			versionId,
			filename: input.filename,
		})
		const mimeType = contentTypeForExtension(safeExtension(input.filename) || extension)
		// storage_path stays populated for continuity with pre-Phase-5 rows: it is
		// the resolved filesystem path locally, and the object key in Azure mode.
		const storagePath =
			this.storage.mode === "local"
				? path.resolve(getConfig().paths.storageDir, ...storageKey.split("/"))
				: storageKey

		// 5a. PENDING METADATA FIRST. Blob Storage and Neon cannot share one
		// transaction, so the database records the intent before the bytes exist.
		// A crash between here and 5b leaves a `pending` row and no object, which
		// the retry path above cleans up - never a silently orphaned file.
		this.db.run(
			`INSERT INTO document_versions (id, tenant_id, document_id, version, status, effective_date, uploaded_at,
				uploaded_by, storage_path, storage_provider, storage_container, storage_key, original_filename,
				mime_type, size_bytes, checksum, char_count, chunk_count, ingest_status)
			 VALUES (?, ?, ?, ?, 'inactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
			versionId,
			input.tenantId,
			documentId,
			versionLabel,
			input.effectiveDate || detected.effectiveDate || now.slice(0, 10),
			now,
			input.uploadedBy,
			storagePath,
			this.storage.mode,
			this.storage.container,
			storageKey,
			input.filename,
			mimeType,
			input.buffer.byteLength,
			checksum,
			extracted.text.length,
		)

		// 5b. UPLOAD THE ORIGINAL. Only operational metadata travels with the
		// object: Neon remains the authoritative authorization source, so no ACL,
		// classification or user identity is written to storage metadata.
		try {
			await this.storage.put(storageKey, input.buffer, {
				contentType: mimeType,
				contentDisposition: `attachment; filename="${safeDownloadName(input.filename)}"`,
				metadata: { tenantid: input.tenantId, documentid: documentId, versionid: versionId },
			})
		} catch (error) {
			// Compensation: a half-written object must not survive, and the version
			// must never be presented as ready.
			await this.storage.delete(storageKey).catch(() => {})
			this.db.run(
				`UPDATE document_versions SET ingest_status = 'failed', ingest_error = ? WHERE id = ? AND tenant_id = ?`,
				"storage upload failed",
				versionId,
				input.tenantId,
			)
			log.error("storage.upload_failed", {
				tenantId: input.tenantId,
				documentId,
				versionId,
				provider: this.storage.mode,
				// Structured, scrubbed provider diagnostic. Never a connection string.
				detail: error instanceof StorageError ? error.diagnostic : "unknown storage failure",
			})
			throw new DocumentError("The document could not be stored, so nothing was indexed. Please retry.", 502)
		}

		// 6. CHUNK + 7. EMBED + 8. INDEX
		const injectionFlags = new Set<string>()
		let chunkCount = 0
		try {
			this.setIngestStatus(input.tenantId, versionId, "indexing")
			const chunks = chunkText(extracted.text, {
				targetChars: config.retrieval.chunkChars,
				overlapChars: config.retrieval.chunkOverlap,
			})
			const vectors = await this.embeddings.embed(chunks.map((c) => `${title}\n${c.text}`))

			const chunkIds: string[] = []
			const chunkFlags: string[][] = []
			for (let i = 0; i < chunks.length; i += 1) {
				const chunk = chunks[i]
				const flags = detectInjection(chunk.text)
				flags.forEach((f) => injectionFlags.add(f))
				chunkFlags.push(flags)
				const keywords = [...new Set(tokenize(`${chunk.section} ${chunk.text}`))].slice(0, 40).join(" ")
				const chunkId = `chk_${randomUUID()}`
				chunkIds.push(chunkId)
				this.db.run(
					`INSERT INTO document_chunks (id, tenant_id, document_id, version_id, seq, section, text,
						char_count, keywords, embedding, embedding_model, injection_flags)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					chunkId,
					input.tenantId,
					documentId,
					versionId,
					chunk.seq,
					chunk.section,
					chunk.text,
					chunk.text.length,
					keywords,
					floatsToBuffer(vectors[i]),
					this.embeddings.model,
					JSON.stringify(flags),
				)
			}
			chunkCount = chunks.length

			// Mirror into an external vector store (Azure AI Search) when configured.
			// The embeddings computed above are reused: indexing never re-embeds.
			// A brand new version is indexed with versionActive=false; activateVersion()
			// flips the flag afterwards without touching a vector.
			if (this.vectorStore.mode !== "local") {
				const allowedRoles: string[] = JSON.parse(
					this.db.get<any>(`SELECT allowed_roles_json AS j FROM documents WHERE tenant_id = ? AND id = ?`, input.tenantId, documentId)?.j || "[]",
				)
				const allowedUsers: string[] = JSON.parse(
					this.db.get<any>(`SELECT allowed_users_json AS j FROM documents WHERE tenant_id = ? AND id = ?`, input.tenantId, documentId)?.j || "[]",
				)
				await this.vectorStore.upsert(
					chunks.map((chunk, i) => ({
						chunkId: chunkIds[i],
						tenantId: input.tenantId,
						documentId,
						versionId,
						embedding: vectors[i],
						text: chunk.text,
						section: chunk.section,
						seq: chunk.seq,
						keywords: "",
						injectionFlags: chunkFlags[i],
						documentTitle: title,
						department,
						category,
						classification,
						version: versionLabel,
						filename: input.filename,
						sourceType: extracted.sourceType,
						allowedRoles,
						allowedUsers,
						documentActive: true,
						versionActive: false,
						uploadedBy: input.uploadedBy,
						uploadedAt: now,
						effectiveDate: input.effectiveDate || detected.effectiveDate || now.slice(0, 10),
						// NOVA's extractors do not produce page numbers; reporting null is
						// honest, and the citation layer omits the field rather than guessing.
						page: null,
					})),
				)
			}

			this.db.run(
				`UPDATE document_versions SET chunk_count = ?, ingest_status = 'indexed', ingest_error = NULL WHERE id = ? AND tenant_id = ?`,
				chunkCount,
				versionId,
				input.tenantId,
			)
		} catch (error) {
			// Search is DERIVED data. A failed indexing pass never invalidates the
			// stored original: the object stays, the version is marked failed, and
			// re-uploading the same bytes retries from the stored state.
			this.db.run(
				`UPDATE document_versions SET ingest_status = 'failed', ingest_error = ? WHERE id = ? AND tenant_id = ?`,
				String((error as Error).message).slice(0, 300),
				versionId,
				input.tenantId,
			)
			log.error("ingestion.failed", { tenantId: input.tenantId, documentId, detail: (error as Error).message })
			throw new DocumentError("Indexing failed for this document. It was stored but is not searchable.", 500)
		}

		// 9. ACTIVATE (supersedes the previous active version)
		if (input.activate !== false) await this.activateVersion(input.tenantId, documentId, versionId)

		const document = this.getDocument(input.tenantId, documentId)!
		const version = this.listVersions(input.tenantId, documentId).find((v) => v.id === versionId)!
		// Audit trail: metadata only. Document text is never written to activity logs.
		recordActivity(this.db, {
			tenantId: input.tenantId,
			userId: input.uploadedBy,
			action: "Knowledge Ingested",
			resourceType: "document",
			resourceId: documentId,
			status: "success",
			detail: `${document.title} v${versionLabel} - ${department} / ${classification} - ${chunkCount} chunks`,
		})
		log.info("ingestion.completed", {
			tenantId: input.tenantId,
			documentId,
			version: versionLabel,
			chunkCount,
			injectionFlags: [...injectionFlags],
		})
		return {
			document,
			version,
			chunkCount,
			warnings: extracted.warnings,
			injectionFlags: [...injectionFlags],
		}
	}

	private setIngestStatus(tenantId: string, versionId: string, status: IngestStatus): void {
		this.db.run(
			`UPDATE document_versions SET ingest_status = ? WHERE id = ? AND tenant_id = ?`,
			status,
			versionId,
			tenantId,
		)
	}

	/* ----------------------------- storage -------------------------------- */

	/**
	 * Removes an incomplete version: its chunks, its index entries and the object
	 * it may have written. Used only for versions that never reached `indexed`,
	 * so a retry of the same bytes starts from a clean state.
	 */
	private async discardVersion(tenantId: string, version: DocumentVersion): Promise<void> {
		try {
			await this.vectorStore.deleteByVersion(tenantId, version.id)
		} catch (error) {
			log.warn("storage.index_cleanup_failed", { tenantId, versionId: version.id, detail: (error as Error).message })
		}
		await this.removeVersionObject(tenantId, version)
		this.db.run(`DELETE FROM document_chunks WHERE tenant_id = ? AND version_id = ?`, tenantId, version.id)
		this.db.run(`DELETE FROM document_versions WHERE tenant_id = ? AND id = ?`, tenantId, version.id)
	}

	/** Best-effort physical delete of one version's stored original. */
	private async removeVersionObject(tenantId: string, version: DocumentVersion): Promise<void> {
		try {
			if (version.storageKey) {
				await this.storage.delete(version.storageKey)
				return
			}
			// Pre-Phase-5 row: the locator is an absolute filesystem path. Only a
			// local deployment can own such a file.
			if (this.storage.mode === "local" && version.storagePath && fs.existsSync(version.storagePath)) {
				fs.rmSync(version.storagePath)
			}
		} catch (error) {
			log.warn("storage.delete_failed", {
				tenantId,
				versionId: version.id,
				provider: this.storage.mode,
				detail: error instanceof StorageError ? error.diagnostic : (error as Error).message,
			})
		}
	}

	/**
	 * Authorized read of a version's ORIGINAL file.
	 *
	 * The caller supplies identifiers only. The object key is never accepted from
	 * a client: it is read from Neon and then proved to belong to exactly this
	 * tenant/document/version before the provider is touched. A caller who may
	 * not read the document gets the same 404 as one asking for a document that
	 * does not exist (no existence oracle).
	 */
	async readVersionFile(
		scope: AccessScope,
		tenantId: string,
		documentId: string,
		versionId: string,
	): Promise<{ stream: Readable; filename: string; contentType: string; size: number; version: DocumentVersion }> {
		if (scope.tenantId !== tenantId) throw new DocumentError("Document not found.", 404)
		const document = this.getDocument(tenantId, documentId)
		if (!document) throw new DocumentError("Document not found.", 404)
		const decision = decideDocumentAccess(scope, {
			tenantId: document.tenantId,
			documentId: document.id,
			department: document.department,
			classification: document.classification,
			allowedRoles: document.allowedRoles,
			allowedUsers: document.allowedUsers,
		})
		if (!decision.allowed) throw new DocumentError("Document not found.", 404)

		const row = this.db.get(
			`SELECT * FROM document_versions WHERE tenant_id = ? AND document_id = ? AND id = ?`,
			tenantId,
			documentId,
			versionId,
		)
		if (!row) throw new DocumentError("Version not found.", 404)
		const version = rowToVersion(row)

		const filename = version.originalFilename || document.filename
		const contentType = version.mimeType || contentTypeForExtension(extensionOf(filename))

		if (version.storageKey) {
			// The key encodes its owner, so a row can never point at another
			// tenant's object - even if the database were tampered with.
			const expectedPrefix = `tenant/${tenantId}/document/${documentId}/version/${versionId}/`
			if (!version.storageKey.startsWith(expectedPrefix)) {
				log.error("storage.key_mismatch", { tenantId, documentId, versionId })
				throw new DocumentError("The stored document file is unavailable.", 409)
			}
			const stream = await this.storage.getStream(version.storageKey)
			return { stream, filename, contentType, size: version.sizeBytes, version }
		}

		// Pre-Phase-5 row. Only a local deployment can serve an absolute path;
		// in Azure mode this is a data problem, not a silent local read.
		if (this.storage.mode !== "local") {
			throw new DocumentError("This document version predates Blob Storage and must be re-uploaded.", 409)
		}
		if (!version.storagePath || !fs.existsSync(version.storagePath)) {
			throw new DocumentError("The stored document file is no longer available.", 404)
		}
		return {
			stream: fs.createReadStream(version.storagePath),
			filename,
			contentType,
			size: version.sizeBytes || fs.statSync(version.storagePath).size,
			version,
		}
	}

	/* --------------------------- lifecycle ------------------------------- */

	async activateVersion(tenantId: string, documentId: string, versionId: string): Promise<DocumentVersion> {
		const version = this.db.get(
			`SELECT * FROM document_versions WHERE tenant_id = ? AND document_id = ? AND id = ?`,
			tenantId,
			documentId,
			versionId,
		)
		if (!version) throw new DocumentError("Version not found.", 404)
		if (version.ingest_status !== "indexed") {
			throw new DocumentError("Only successfully indexed versions can be activated.", 409)
		}
		this.db.transaction(() => {
			this.db.run(
				`UPDATE document_versions SET status = 'inactive' WHERE tenant_id = ? AND document_id = ?`,
				tenantId,
				documentId,
			)
			this.db.run(
				`UPDATE document_versions SET status = 'active' WHERE tenant_id = ? AND id = ?`,
				tenantId,
				versionId,
			)
			this.db.run(
				`UPDATE documents SET status = 'active', updated_at = ? WHERE tenant_id = ? AND id = ?`,
				new Date().toISOString(),
				tenantId,
				documentId,
			)
		})
		// Keep the external index's lifecycle flags in step with the database, so
		// a superseded version stops being retrievable immediately. Flag-only
		// merges: no embedding call and no content rewrite.
		await this.syncVersionFlags(tenantId, documentId)
		return rowToVersion(
			this.db.get(`SELECT * FROM document_versions WHERE tenant_id = ? AND id = ?`, tenantId, versionId),
		)
	}

	/**
	 * Mirrors document_versions.status into the external index for every version
	 * of a document. Called after any activation change.
	 */
	private async syncVersionFlags(tenantId: string, documentId: string): Promise<void> {
		if (this.vectorStore.mode === "local" || !this.vectorStore.setActiveFlags) return
		const versions = this.db.all<any>(
			`SELECT id, status FROM document_versions WHERE tenant_id = ? AND document_id = ?`,
			tenantId,
			documentId,
		)
		for (const version of versions) {
			await this.vectorStore.setActiveFlags(tenantId, { versionId: version.id }, { versionActive: version.status === "active" })
		}
	}

	/**
	 * Deactivation is a LIFECYCLE change, not a deletion. The stored original is
	 * deliberately retained: only the retrieval flags change, so history stays
	 * recoverable exactly as NOVA's versioning model requires.
	 */
	async deactivateVersion(tenantId: string, documentId: string, versionId: string): Promise<void> {
		this.db.run(
			`UPDATE document_versions SET status = 'inactive' WHERE tenant_id = ? AND document_id = ? AND id = ?`,
			tenantId,
			documentId,
			versionId,
		)
		if (this.vectorStore.mode !== "local" && this.vectorStore.setActiveFlags) {
			await this.vectorStore.setActiveFlags(tenantId, { versionId }, { versionActive: false })
		}
	}

	/** Deactivating a document removes it from retrieval but preserves history. */
	async setDocumentStatus(tenantId: string, documentId: string, status: "active" | "inactive"): Promise<void> {
		this.db.run(
			`UPDATE documents SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
			status,
			new Date().toISOString(),
			tenantId,
			documentId,
		)
		if (this.vectorStore.mode !== "local" && this.vectorStore.setActiveFlags) {
			await this.vectorStore.setActiveFlags(tenantId, { documentId }, { documentActive: status === "active" })
		}
	}

	async updateMetadata(
		tenantId: string,
		documentId: string,
		patch: {
			title?: string
			department?: string
			category?: string
			classification?: Classification
			allowedRoles?: string[]
			allowedUsers?: string[]
		},
	): Promise<KnowledgeDocument> {
		const document = this.getDocument(tenantId, documentId)
		if (!document) throw new DocumentError("Document not found.", 404)
		const next = { ...document, ...patch }
		this.db.run(
			`UPDATE documents SET title = ?, department = ?, category = ?, classification = ?,
				allowed_roles_json = ?, allowed_users_json = ?, updated_at = ?
			 WHERE tenant_id = ? AND id = ?`,
			next.title,
			next.department,
			next.category,
			next.classification,
			JSON.stringify(next.allowedRoles),
			JSON.stringify(next.allowedUsers),
			new Date().toISOString(),
			tenantId,
			documentId,
		)
		const updated = this.getDocument(tenantId, documentId)!
		// ACL / classification / department changes must reach the security filter
		// immediately. Title changes DO affect the embedded text ("title\ntext"),
		// so a title change is reported as needing a reindex rather than silently
		// leaving a stale vector behind; the metadata itself is still corrected here.
		if (this.vectorStore.mode !== "local") {
			const azure = this.vectorStore as unknown as {
				upsertMetadata?: (docs: Array<Record<string, unknown>>) => Promise<void>
				keysForDocument?: (tenantId: string, documentId: string) => Promise<string[]>
			}
			if (azure.upsertMetadata && this.vectorStore.setActiveFlags) {
				const chunks = this.db.all<any>(
					`SELECT id FROM document_chunks WHERE tenant_id = ? AND document_id = ?`,
					tenantId,
					documentId,
				)
				await azure.upsertMetadata(
					chunks.map((c: any) => ({
						id: searchDocumentKey(tenantId, c.id),
						title: updated.title,
						department: updated.department,
						category: updated.category,
						classification: updated.classification,
						classificationLevel: CLASSIFICATION_LEVEL[updated.classification] ?? 99,
						allowedRoles: updated.allowedRoles,
						allowedUsers: updated.allowedUsers,
					})),
				)
			}
		}
		return updated
	}

	/**
	 * Permanent delete: the document leaves the retrieval index, every version's
	 * stored original is removed, then the metadata rows go.
	 *
	 * Order matters. Search (derived) is cleared first so nothing stays
	 * retrievable if a later step fails; the objects go next; the Neon rows last,
	 * because they are the only record of which objects to remove. A failure
	 * before the rows are deleted therefore leaves a retryable delete, never an
	 * unreferenced file.
	 */
	async deleteDocument(tenantId: string, documentId: string): Promise<void> {
		const versions = this.listVersions(tenantId, documentId)
		await this.vectorStore.deleteByDocument(tenantId, documentId)
		for (const version of versions) await this.removeVersionObject(tenantId, version)
		this.db.run(`DELETE FROM document_chunks WHERE tenant_id = ? AND document_id = ?`, tenantId, documentId)
		this.db.run(`DELETE FROM document_versions WHERE tenant_id = ? AND document_id = ?`, tenantId, documentId)
		this.db.run(`DELETE FROM documents WHERE tenant_id = ? AND id = ?`, tenantId, documentId)
	}

	stats(tenantId: string) {
		const documents = this.db.get(
			`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status = 'active'`,
			tenantId,
		)
		const chunks = this.db.get(`SELECT COUNT(*) AS n FROM document_chunks WHERE tenant_id = ?`, tenantId)
		const versions = this.db.get(`SELECT COUNT(*) AS n FROM document_versions WHERE tenant_id = ?`, tenantId)
		const failed = this.db.get(
			`SELECT COUNT(*) AS n FROM document_versions WHERE tenant_id = ? AND ingest_status = 'failed'`,
			tenantId,
		)
		const departments = this.db.all(
			`SELECT department, COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status = 'active' GROUP BY department ORDER BY n DESC`,
			tenantId,
		)
		return {
			documents: Number(documents?.n ?? 0),
			chunks: Number(chunks?.n ?? 0),
			versions: Number(versions?.n ?? 0),
			failedIngestions: Number(failed?.n ?? 0),
			byDepartment: departments.map((d) => ({ department: d.department, count: Number(d.n) })),
		}
	}
}
