/**
 * Azure AI Search management commands.
 *
 *   npm run search:validate   inspect the live index against the expected schema
 *   npm run search:status     index existence, document count, per-tenant totals
 *   npm run search:index      incremental upsert of all indexable chunks
 *   npm run search:reindex    same, with --force to rebuild every vector
 *
 * Embedding cost: this command normally makes ZERO embedding calls. Chunk
 * vectors are produced once during ingestion and stored in document_chunks;
 * indexing reuses them. An embedding call happens only when a chunk has no
 * stored vector (or --force is used), and the count is reported honestly.
 *
 * Nothing here ever prints the admin key.
 */
import { pathToFileURL } from "node:url"
import { getConfig, loadEnv } from "../src/config/index.ts"
import { Database } from "../src/db/index.ts"
import { createEmbeddingProvider } from "../src/embeddings/index.ts"
import { bufferToFloats, floatsToBuffer } from "../src/embeddings/base.ts"
import { createAzureVectorStore } from "../src/knowledge/index.ts"
import { SearchError } from "../src/azure/search.ts"
import {
	NOVA_SEARCH_INDEX_VERSION,
	buildIndexDefinition,
	ensureIndex,
	searchDocumentKey,
	validateIndexDefinition,
} from "../src/retrieval/vector/azure-index.ts"
import { contentHashOf, metadataHashOf, toSearchDocument, type AzureVectorStore } from "../src/retrieval/vector/azure.ts"
import { VECTOR_FIELD } from "../src/retrieval/vector/azure-index.ts"
import type { VectorRecord } from "../src/retrieval/vector/base.ts"
import type { Classification } from "../src/models/types.ts"

export type IndexReport = {
	documentsDiscovered: number
	versionsDiscovered: number
	chunksDiscovered: number
	newChunks: number
	changedChunks: number
	metadataOnlyUpdates: number
	unchangedChunks: number
	deletedChunks: number
	embeddingsGenerated: number
	indexed: number
	failed: number
	errors: string[]
}

type ChunkRow = {
	chunk_id: string
	tenant_id: string
	document_id: string
	version_id: string
	seq: number
	section: string
	text: string
	embedding: Uint8Array | null
	injection_flags: string
	title: string
	filename: string
	department: string
	category: string
	classification: string
	source_type: string
	doc_status: string
	allowed_roles_json: string
	allowed_users_json: string
	version: string
	version_status: string
	uploaded_by: string
	uploaded_at: string
	effective_date: string
}

/**
 * Every chunk of every document, active or not. Historical versions stay
 * indexed for traceability; the versionActive flag (not absence from the
 * index) is what keeps them out of ordinary retrieval.
 */
const CHUNK_SQL = `
	SELECT c.id AS chunk_id, c.tenant_id, c.document_id, c.version_id, c.seq, c.section, c.text,
	       c.embedding, c.injection_flags,
	       d.title, d.filename, d.department, d.category, d.classification, d.source_type,
	       d.status AS doc_status, d.allowed_roles_json, d.allowed_users_json,
	       v.version, v.status AS version_status, v.uploaded_by, v.uploaded_at, v.effective_date
	  FROM document_chunks c
	  JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
	  JOIN document_versions v ON v.id = c.version_id AND v.tenant_id = c.tenant_id
	 ORDER BY c.tenant_id, c.document_id, c.seq`

function toRecord(row: ChunkRow, embedding: Float32Array): VectorRecord {
	return {
		chunkId: row.chunk_id,
		tenantId: row.tenant_id,
		documentId: row.document_id,
		versionId: row.version_id,
		embedding,
		text: row.text,
		section: row.section ?? "",
		seq: Number(row.seq),
		keywords: "",
		injectionFlags: JSON.parse(row.injection_flags || "[]"),
		documentTitle: row.title,
		department: row.department,
		category: row.category,
		classification: row.classification as Classification,
		version: row.version,
		filename: row.filename,
		sourceType: row.source_type,
		allowedRoles: JSON.parse(row.allowed_roles_json || "[]"),
		allowedUsers: JSON.parse(row.allowed_users_json || "[]"),
		documentActive: row.doc_status === "active",
		versionActive: row.version_status === "active",
		uploadedBy: row.uploaded_by,
		uploadedAt: row.uploaded_at ?? null,
		effectiveDate: row.effective_date ? `${row.effective_date}T00:00:00Z`.replace(/T.*T/, "T") : null,
		// NOVA's text extractors do not produce page numbers. Reported as null
		// rather than invented; the citation layer omits the field.
		page: null,
	}
}

/** Normalises whatever the DB stored into an ISO instant Azure will accept, or null. */
function isoOrNull(value: string | null | undefined): string | null {
	if (!value) return null
	const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
	return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function runIndex(
	db: Database,
	store: AzureVectorStore,
	embeddings: { embed: (texts: string[]) => Promise<Float32Array[]>; dim: number },
	options: { force?: boolean; log?: (line: string) => void } = {},
): Promise<IndexReport> {
	const log = options.log ?? (() => {})
	const report: IndexReport = {
		documentsDiscovered: 0,
		versionsDiscovered: 0,
		chunksDiscovered: 0,
		newChunks: 0,
		changedChunks: 0,
		metadataOnlyUpdates: 0,
		unchangedChunks: 0,
		deletedChunks: 0,
		embeddingsGenerated: 0,
		indexed: 0,
		failed: 0,
		errors: [],
	}

	const rows = db.all<ChunkRow>(CHUNK_SQL)
	report.chunksDiscovered = rows.length
	report.documentsDiscovered = new Set(rows.map((r) => `${r.tenant_id}/${r.document_id}`)).size
	report.versionsDiscovered = new Set(rows.map((r) => `${r.tenant_id}/${r.version_id}`)).size

	// Group by document so change detection is one Search read per document.
	const byDocument = new Map<string, ChunkRow[]>()
	for (const row of rows) {
		const key = `${row.tenant_id}\u0000${row.document_id}`
		if (!byDocument.has(key)) byDocument.set(key, [])
		byDocument.get(key)!.push(row)
	}

	for (const [key, docRows] of byDocument) {
		const [tenantId, documentId] = key.split("\u0000")
		try {
			const existing = options.force ? new Map() : await store.fetchHashes(tenantId, documentId)

			const fullUpserts: VectorRecord[] = []
			const metadataMerges: Array<Record<string, unknown> & { id: string }> = []
			const needEmbedding: ChunkRow[] = []

			for (const row of docRows) {
				const stored = bufferToFloats(row.embedding)
				const record = toRecord(row, stored)
				record.effectiveDate = isoOrNull(row.effective_date)
				record.uploadedAt = isoOrNull(row.uploaded_at)
				const contentHash = contentHashOf(record)
				const metadataHash = metadataHashOf(record)
				const prior = existing.get(row.chunk_id)

				if (prior && prior.contentHash === contentHash && prior.metadataHash === metadataHash) {
					report.unchangedChunks += 1
					continue
				}
				if (prior && prior.contentHash === contentHash) {
					// Vector-relevant content is identical: merge metadata only.
					// No embedding call and no vector upload.
					const doc = toSearchDocument(record) as Record<string, unknown>
					delete doc[VECTOR_FIELD]
					metadataMerges.push(doc as Record<string, unknown> & { id: string })
					report.metadataOnlyUpdates += 1
					continue
				}
				if (prior) report.changedChunks += 1
				else report.newChunks += 1

				if (stored.length === embeddings.dim && !options.force) {
					fullUpserts.push(record)
				} else {
					// Only reached when a chunk has no usable stored vector, or --force.
					needEmbedding.push(row)
				}
			}

			if (needEmbedding.length) {
				const texts = needEmbedding.map((r) => `${r.title}\n${r.text}`)
				const vectors = await embeddings.embed(texts)
				report.embeddingsGenerated += vectors.length
				for (let i = 0; i < needEmbedding.length; i += 1) {
					const row = needEmbedding[i]
					const record = toRecord(row, vectors[i])
					record.effectiveDate = isoOrNull(row.effective_date)
					record.uploadedAt = isoOrNull(row.uploaded_at)
					fullUpserts.push(record)
					// Persist so the next run reuses it instead of paying again.
					db.run(
						`UPDATE document_chunks SET embedding = ?, embedding_model = ? WHERE id = ? AND tenant_id = ?`,
						floatsToBuffer(vectors[i]),
						(embeddings as any).model ?? "",
						row.chunk_id,
						row.tenant_id,
					)
				}
			}

			if (fullUpserts.length) await store.upsert(fullUpserts)
			if (metadataMerges.length) await store.upsertMetadata(metadataMerges as any)
			report.indexed += fullUpserts.length + metadataMerges.length

			// Chunks that exist in Search but no longer in the database are stale.
			report.deletedChunks += await store.deleteMissingChunks(
				tenantId,
				documentId,
				docRows.map((r) => r.chunk_id),
			)
			log(`document ${documentId}  chunks=${docRows.length}  upserted=${fullUpserts.length}  metadata=${metadataMerges.length}`)
		} catch (error) {
			report.failed += docRows.length
			const message = error instanceof SearchError ? error.diagnostic : String((error as Error)?.message ?? error)
			report.errors.push(`document ${documentId}: ${message}`)
			log(`document ${documentId}  FAILED: ${message}`)
		}
	}
	return report
}

function printReport(report: IndexReport): void {
	console.log("")
	console.log(`Documents discovered:   ${report.documentsDiscovered}`)
	console.log(`Versions discovered:    ${report.versionsDiscovered}`)
	console.log(`Chunks discovered:      ${report.chunksDiscovered}`)
	console.log(`New chunks:             ${report.newChunks}`)
	console.log(`Changed chunks:         ${report.changedChunks}`)
	console.log(`Metadata-only updates:  ${report.metadataOnlyUpdates}`)
	console.log(`Unchanged chunks:       ${report.unchangedChunks}`)
	console.log(`Deleted chunks:         ${report.deletedChunks}`)
	console.log(`Embeddings generated:   ${report.embeddingsGenerated}`)
	console.log(`Search documents sent:  ${report.indexed}`)
	console.log(`Failed:                 ${report.failed}`)
	for (const error of report.errors) console.log(`  ! ${error}`)
}

async function main(): Promise<void> {
	loadEnv()
	const command = process.argv[2] ?? "status"
	const force = process.argv.includes("--force")
	const config = getConfig()

	if (config.modes.vectorStore !== "azure_search") {
		throw new Error("The search:* commands require VECTOR_STORE=azure_search (local mode uses the SQLite vector store).")
	}

	const store = createAzureVectorStore()
	const dim = config.embeddings.dim
	// Endpoint and index only; the admin key is never printed.
	console.log(`endpoint ${store.client.endpoint}`)
	console.log(`index    ${store.client.index} (NOVA schema v${NOVA_SEARCH_INDEX_VERSION}, api-version ${store.client.apiVersion})`)
	console.log(`vector   ${dim} dimensions, field ${VECTOR_FIELD}`)

	if (command === "validate") {
		const expected = buildIndexDefinition(store.client.index, dim)
		const validation = validateIndexDefinition(await store.client.getIndex(), expected)
		if (!validation.exists) {
			console.log("index does not exist; run `npm run search:index` to create it")
			process.exitCode = 1
			return
		}
		console.log(`fields   ${validation.fieldCount}`)
		console.log(`vector dimensions: index=${validation.actualDimensions} expected=${validation.expectedDimensions}`)
		if (validation.compatible) {
			console.log("index schema is compatible")
			return
		}
		for (const problem of validation.problems) console.log(`  ! ${problem}`)
		process.exitCode = 1
		return
	}

	if (command === "status") {
		const live = await store.client.getIndex()
		if (!live) {
			console.log("index does not exist")
			process.exitCode = 1
			return
		}
		console.log(`documents indexed: ${await store.client.documentCount()}`)
		return
	}

	if (command === "index" || command === "reindex") {
		const result = await ensureIndex(store.client, dim)
		console.log(`index ${result.action}`)
		const db = new Database(config.database.url)
		try {
			const embeddings = createEmbeddingProvider()
			if (embeddings.dim !== dim) {
				throw new Error(`Embedding provider reports ${embeddings.dim} dimensions but EMBEDDING_DIM is ${dim}; refusing to index.`)
			}
			printReport(await runIndex(db, store, embeddings, { force, log: (l) => console.log(l) }))
		} finally {
			db.close()
		}
		return
	}

	throw new Error(`Unknown search command "${command}". Use validate | status | index | reindex.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		console.error(error instanceof SearchError ? error.diagnostic : (error as Error).message)
		process.exit(1)
	})
}
