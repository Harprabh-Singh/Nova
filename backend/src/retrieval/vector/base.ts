/** Vector store abstraction: local SQLite-backed, or Azure AI Search in Azure mode. */
import type { AccessScope } from "../../authorization/policy.ts"
import type { Classification } from "../../models/types.ts"

export type VectorRecord = {
	chunkId: string
	tenantId: string
	documentId: string
	versionId: string
	embedding: Float32Array
	text: string
	section: string
	seq: number
	keywords: string
	injectionFlags: string[]
	documentTitle: string
	department: string
	category: string
	classification: Classification
	version: string
	/**
	 * Fields below are only needed by an external index (Azure AI Search), which
	 * has to carry the ACL and lifecycle state that the local store reads by
	 * joining documents/document_versions. Optional so LocalVectorStore callers
	 * are unaffected.
	 */
	filename?: string
	sourceType?: string
	allowedRoles?: string[]
	allowedUsers?: string[]
	documentActive?: boolean
	versionActive?: boolean
	uploadedBy?: string
	uploadedAt?: string | null
	effectiveDate?: string | null
	/** Real page number when the source format provides one; never fabricated. */
	page?: number | null
}

/**
 * Filters are applied inside the store so unauthorized rows never leave it.
 *
 * `scope` is the server-resolved AccessScope and is the authoritative input for
 * security trimming. LocalVectorStore consumes the precomputed `accessSql`
 * predicate; AzureVectorStore compiles `scope` into a single OData filter
 * (backend/src/retrieval/vector/odata.ts). Neither store accepts a filter
 * supplied by a caller, and AzureVectorStore fails closed if `scope` is absent.
 */
export type VectorQueryFilter = {
	tenantId: string
	/** Server-resolved authorization scope. Required by AzureVectorStore. */
	scope?: AccessScope
	/** Precomputed SQL authorization predicate (local store only). */
	accessSql?: { sql: string; params: any[] }
	/** Non-security narrowing hint; can only ever reduce the result set. */
	departments?: string[]
	onlyActiveVersions?: boolean
}

export interface VectorStore {
	readonly name: string
	readonly mode: "local" | "azure_search"
	upsert(records: VectorRecord[]): Promise<void>
	deleteByVersion(tenantId: string, versionId: string): Promise<void>
	deleteByDocument(tenantId: string, documentId: string): Promise<void>
	search(
		queryVector: Float32Array,
		queryTerms: string[],
		filter: VectorQueryFilter,
		limit: number,
	): Promise<Array<VectorRecord & { vectorScore: number; keywordScore: number }>>
	/** Updates lifecycle flags for already-indexed chunks without re-embedding. */
	setActiveFlags?(tenantId: string, selector: { documentId?: string; versionId?: string }, flags: { documentActive?: boolean; versionActive?: boolean }): Promise<number>
	/** Metadata-only probe: returns counts, never text. Used for denial detection. */
	countMatchingOutsideScope?(queryTerms: string[], filter: VectorQueryFilter): Promise<number>
	/**
	 * Metadata-only probe returning how many distinct query terms the single best
	 * out-of-scope chunk matches. No text, title or metadata ever leaves the store;
	 * the agent uses this to tell "you may not see this" apart from "we do not know".
	 */
	bestTermMatchOutsideScope?(queryTerms: string[], filter: VectorQueryFilter): Promise<number>
	healthCheck(): Promise<{ ok: boolean; detail: string }>
}
