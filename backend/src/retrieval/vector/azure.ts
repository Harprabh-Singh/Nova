/**
 * AzureVectorStore - the production/Azure retrieval store (VECTOR_STORE=azure_search).
 *
 * Hybrid retrieval: one Search request carries both the lexical query and the
 * vector query, and ONE request-level `filter` governs both. That filter is the
 * compiled authorization scope (see ./odata.ts); per-vector filter overrides are
 * never used, because a vector-level override replaces the global filter and
 * would silently drop tenant and ACL predicates.
 *
 * Failure policy: in Azure mode a Search failure is an explicit SearchError.
 * There is no fallback to local retrieval - falling back would answer from a
 * store the deployment did not authorize and could not have kept in sync.
 */
import crypto from "node:crypto"
import { SearchClient, SearchError, type SearchClientOptions } from "../../azure/search.ts"
import { NOVA_SEARCH_INDEX_VERSION, RETRIEVAL_SELECT_FIELDS, VECTOR_FIELD, searchDocumentKey, type NovaSearchDocument } from "./azure-index.ts"
import { buildSecurityFilter, classificationLevel, odataLiteral } from "./odata.ts"
import type { VectorQueryFilter, VectorRecord, VectorStore } from "./base.ts"
import type { Classification } from "../../models/types.ts"

/** Azure rejects oversized index batches; 1000 actions is the documented ceiling. */
const INDEX_BATCH_SIZE = 200
/** Page size when enumerating keys for deletion or flag updates. */
const KEY_PAGE_SIZE = 1000

export type AzureVectorStoreOptions = Omit<SearchClientOptions, "apiKey"> & {
	apiKey: string
	/** Must equal the embedding provider's width. Validated on every write and query. */
	dimensions: number
}

/** Content that, when changed, invalidates the stored embedding. */
export function contentHashOf(record: Pick<VectorRecord, "text" | "section" | "documentTitle">): string {
	return crypto.createHash("sha256").update(`${record.documentTitle}\u0000${record.section}\u0000${record.text}`).digest("hex")
}

/** Metadata that can change without invalidating the embedding (ACLs, flags, labels). */
export function metadataHashOf(record: VectorRecord): string {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify([
				record.department,
				record.category,
				record.classification,
				record.version,
				record.filename ?? "",
				record.sourceType ?? "",
				[...(record.allowedRoles ?? [])].sort(),
				[...(record.allowedUsers ?? [])].sort(),
				record.documentActive !== false,
				record.versionActive !== false,
				record.uploadedBy ?? "",
				record.uploadedAt ?? null,
				record.effectiveDate ?? null,
				record.page ?? null,
				record.seq,
				[...(record.injectionFlags ?? [])].sort(),
			]),
		)
		.digest("hex")
}

export function toSearchDocument(record: VectorRecord): NovaSearchDocument {
	return {
		id: searchDocumentKey(record.tenantId, record.chunkId),
		tenantId: record.tenantId,
		documentId: record.documentId,
		versionId: record.versionId,
		chunkId: record.chunkId,
		title: record.documentTitle,
		filename: record.filename ?? "",
		content: record.text,
		category: record.category,
		sourceType: record.sourceType ?? "",
		department: record.department,
		classification: record.classification,
		classificationLevel: classificationLevel(record.classification),
		allowedRoles: record.allowedRoles ?? [],
		allowedUsers: record.allowedUsers ?? [],
		documentActive: record.documentActive !== false,
		versionActive: record.versionActive !== false,
		version: record.version,
		section: record.section,
		seq: record.seq,
		page: record.page ?? null,
		uploadedBy: record.uploadedBy ?? "",
		uploadedAt: record.uploadedAt ?? null,
		effectiveDate: record.effectiveDate ?? null,
		injectionFlags: record.injectionFlags ?? [],
		contentHash: contentHashOf(record),
		metadataHash: metadataHashOf(record),
		schemaVersion: NOVA_SEARCH_INDEX_VERSION,
	}
}

export class AzureVectorStore implements VectorStore {
	readonly name = "AzureVectorStore"
	readonly mode = "azure_search" as const
	readonly client: SearchClient
	readonly dimensions: number

	constructor(options: AzureVectorStoreOptions) {
		const { dimensions, ...clientOptions } = options
		this.client = new SearchClient(clientOptions)
		this.dimensions = dimensions
	}

	/**
	 * Hard stop on a width mismatch. Truncating or padding would corrupt the
	 * index in a way that only shows up as quietly worse answers.
	 */
	private assertDimension(vector: Float32Array | number[], what: string): void {
		const length = vector.length
		if (length !== this.dimensions) {
			throw new SearchError(
				`Embedding dimension mismatch for ${what}: provider produced ${length}, index "${this.client.index}" expects ${this.dimensions}. ` +
					"Refusing to truncate or pad. Align EMBEDDING_DIM with the index, or rebuild the index.",
				500,
				"bad_request",
			)
		}
	}

	private assertBatch(results: Array<{ key: string; status: boolean; errorMessage?: string }>, operation: string): void {
		const failed = results.filter((r) => !r.status)
		if (failed.length === 0) return
		// Keys are NOVA ids, not content: safe to report. Azure messages are already scrubbed.
		throw new SearchError(
			`Azure AI Search ${operation} failed for ${failed.length}/${results.length} documents: ` +
				failed
					.slice(0, 5)
					.map((f) => `${f.key}: ${f.errorMessage ?? "unknown"}`)
					.join("; "),
			502,
			"upstream",
		)
	}

	async upsert(records: VectorRecord[]): Promise<void> {
		if (records.length === 0) return
		const actions = records.map((record) => {
			this.assertDimension(record.embedding, `chunk ${record.chunkId}`)
			return {
				"@search.action": "mergeOrUpload",
				...toSearchDocument(record),
				[VECTOR_FIELD]: Array.from(record.embedding),
			}
		})
		for (let i = 0; i < actions.length; i += INDEX_BATCH_SIZE) {
			this.assertBatch(await this.client.indexDocuments(actions.slice(i, i + INDEX_BATCH_SIZE)), "upsert")
		}
	}

	/** Metadata-only merge: changes labels/ACLs/flags without touching the vector. */
	async upsertMetadata(documents: Array<Partial<NovaSearchDocument> & { id: string }>): Promise<void> {
		if (documents.length === 0) return
		const actions = documents.map((d) => ({ "@search.action": "merge", ...d }))
		for (let i = 0; i < actions.length; i += INDEX_BATCH_SIZE) {
			this.assertBatch(await this.client.indexDocuments(actions.slice(i, i + INDEX_BATCH_SIZE)), "metadata merge")
		}
	}

	/** Enumerates keys matching a trusted, server-built filter. */
	private async keysMatching(filter: string): Promise<string[]> {
		const keys: string[] = []
		let skip = 0
		for (;;) {
			const page = await this.client.search({ search: "*", filter, select: "id", top: KEY_PAGE_SIZE, skip, count: false })
			const batch: string[] = (page.value ?? []).map((v: any) => String(v.id))
			keys.push(...batch)
			if (batch.length < KEY_PAGE_SIZE) return keys
			skip += KEY_PAGE_SIZE
			if (skip > 100_000) return keys // pathological safety valve
		}
	}

	private async deleteMatching(filter: string): Promise<number> {
		const keys = await this.keysMatching(filter)
		for (let i = 0; i < keys.length; i += INDEX_BATCH_SIZE) {
			this.assertBatch(
				await this.client.indexDocuments(keys.slice(i, i + INDEX_BATCH_SIZE).map((id) => ({ "@search.action": "delete", id }))),
				"delete",
			)
		}
		return keys.length
	}

	async deleteByVersion(tenantId: string, versionId: string): Promise<void> {
		await this.deleteMatching(`tenantId eq ${odataLiteral(tenantId)} and versionId eq ${odataLiteral(versionId)}`)
	}

	async deleteByDocument(tenantId: string, documentId: string): Promise<void> {
		await this.deleteMatching(`tenantId eq ${odataLiteral(tenantId)} and documentId eq ${odataLiteral(documentId)}`)
	}

	/** Chunks not in `keepChunkIds` are stale and removed. Used by incremental reindex. */
	async deleteMissingChunks(tenantId: string, documentId: string, keepChunkIds: string[]): Promise<number> {
		const keep = new Set(keepChunkIds.map((id) => searchDocumentKey(tenantId, id)))
		const present = await this.keysMatching(`tenantId eq ${odataLiteral(tenantId)} and documentId eq ${odataLiteral(documentId)}`)
		const stale = present.filter((id) => !keep.has(id))
		for (let i = 0; i < stale.length; i += INDEX_BATCH_SIZE) {
			this.assertBatch(
				await this.client.indexDocuments(stale.slice(i, i + INDEX_BATCH_SIZE).map((id) => ({ "@search.action": "delete", id }))),
				"delete",
			)
		}
		return stale.length
	}

	/**
	 * Deactivation path: flips lifecycle flags on already-indexed chunks.
	 * No embedding call, and the content stays indexed for traceability while
	 * becoming unreachable through the retrieval filter.
	 */
	async setActiveFlags(
		tenantId: string,
		selector: { documentId?: string; versionId?: string },
		flags: { documentActive?: boolean; versionActive?: boolean },
	): Promise<number> {
		const clauses = [`tenantId eq ${odataLiteral(tenantId)}`]
		if (selector.documentId) clauses.push(`documentId eq ${odataLiteral(selector.documentId)}`)
		if (selector.versionId) clauses.push(`versionId eq ${odataLiteral(selector.versionId)}`)
		const keys = await this.keysMatching(clauses.join(" and "))
		await this.upsertMetadata(keys.map((id) => ({ id, ...flags })))
		return keys.length
	}

	/** Reads the change-detection hashes already stored for a document. */
	async fetchHashes(tenantId: string, documentId: string): Promise<Map<string, { contentHash: string; metadataHash: string }>> {
		const out = new Map<string, { contentHash: string; metadataHash: string }>()
		let skip = 0
		for (;;) {
			const page = await this.client.search({
				search: "*",
				filter: `tenantId eq ${odataLiteral(tenantId)} and documentId eq ${odataLiteral(documentId)}`,
				select: "chunkId,contentHash,metadataHash",
				top: KEY_PAGE_SIZE,
				skip,
				count: false,
			})
			const rows: any[] = page.value ?? []
			for (const row of rows) {
				out.set(String(row.chunkId), { contentHash: String(row.contentHash ?? ""), metadataHash: String(row.metadataHash ?? "") })
			}
			if (rows.length < KEY_PAGE_SIZE) return out
			skip += KEY_PAGE_SIZE
		}
	}

	async search(
		queryVector: Float32Array,
		queryTerms: string[],
		filter: VectorQueryFilter,
		limit: number,
	): Promise<Array<VectorRecord & { vectorScore: number; keywordScore: number }>> {
		// Fail closed: without a server-resolved scope there is no security filter to apply.
		if (!filter.scope) {
			throw new SearchError("Refusing to query Azure AI Search without a server-resolved AccessScope", 500, "bad_request")
		}
		if (filter.scope.tenantId !== filter.tenantId) {
			throw new SearchError("Tenant mismatch between AccessScope and query filter", 500, "bad_request")
		}
		if (queryVector.length) this.assertDimension(queryVector, "query")

		const securityFilter = buildSecurityFilter(filter.scope, {
			onlyActive: filter.onlyActiveVersions !== false,
			departments: filter.departments,
		})

		const body: Record<string, unknown> = {
			search: queryTerms.filter(Boolean).join(" ") || "*",
			queryType: "simple",
			searchMode: "any",
			// ONE authoritative filter for the whole hybrid request.
			filter: securityFilter,
			select: RETRIEVAL_SELECT_FIELDS.join(","),
			top: limit,
			count: false,
		}
		if (queryVector.length) {
			body.vectorQueries = [
				{
					kind: "vector",
					vector: Array.from(queryVector),
					fields: VECTOR_FIELD,
					k: limit,
					// No `filterOverride`: the request-level filter must stay authoritative.
					exhaustive: false,
				},
			]
		}

		const result = await this.client.search(body)
		return (result.value ?? []).map((v: any) => this.mapResult(v))
	}

	/** Azure result -> NOVA record. No Azure-specific shape escapes this method. */
	private mapResult(v: any): VectorRecord & { vectorScore: number; keywordScore: number } {
		const score = Number(v["@search.score"] ?? 0)
		return {
			chunkId: String(v.chunkId ?? ""),
			tenantId: String(v.tenantId ?? ""),
			documentId: String(v.documentId ?? ""),
			versionId: String(v.versionId ?? ""),
			// Vectors are never retrievable and never enter the LLM context.
			embedding: new Float32Array(0),
			text: String(v.content ?? ""),
			section: String(v.section ?? ""),
			seq: Number(v.seq ?? 0),
			keywords: "",
			injectionFlags: Array.isArray(v.injectionFlags) ? v.injectionFlags.map(String) : [],
			documentTitle: String(v.title ?? ""),
			department: String(v.department ?? ""),
			category: String(v.category ?? ""),
			classification: String(v.classification ?? "internal") as Classification,
			version: String(v.version ?? ""),
			filename: String(v.filename ?? ""),
			sourceType: String(v.sourceType ?? ""),
			uploadedBy: String(v.uploadedBy ?? ""),
			uploadedAt: v.uploadedAt ?? null,
			effectiveDate: v.effectiveDate ?? null,
			page: v.page === null || v.page === undefined ? null : Number(v.page),
			/**
			 * Azure returns one fused Reciprocal Rank Fusion score for a hybrid
			 * query; it is not decomposable into separate vector and keyword
			 * components. Reporting it once as the vector score and leaving
			 * keywordScore at 0 is honest; splitting it would be invented data.
			 */
			vectorScore: score,
			keywordScore: 0,
		}
	}

	/**
	 * Counts matching chunks the caller may NOT see, using the negated ACL clause.
	 * Returns a number only - no text, title or id - so a denial can never leak metadata.
	 */
	async countMatchingOutsideScope(queryTerms: string[], filter: VectorQueryFilter): Promise<number> {
		if (!filter.scope || filter.scope.isAdmin) return 0
		const terms = queryTerms.filter(Boolean).join(" ")
		if (!terms.trim()) return 0
		const result = await this.client.search({
			search: terms,
			queryType: "simple",
			searchMode: "any",
			filter: buildSecurityFilter(filter.scope, { onlyActive: true, negate: true }),
			select: "id",
			top: 0,
			count: true,
		})
		return Number(result["@odata.count"] ?? 0)
	}

	/**
	 * Local-only configuration inspection. Deliberately makes NO network call:
	 * /api/health must stay zero-probe as well as zero-token.
	 */
	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		return { ok: true, detail: `Azure AI Search configured for index ${this.client.index} (no live probe performed).` }
	}
}
// hist: 2026-09-23T07:52:06+05:30
