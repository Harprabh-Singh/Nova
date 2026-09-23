/**
 * The nova-knowledge index schema, plus creation and validation.
 *
 * Design decisions:
 * - ONE index for all tenants. Security is a per-query filter, not a per-tenant
 *   index; the Free tier allows 3 indexes total, and per-tenant indexes would
 *   move the security boundary into index naming, which is far easier to get
 *   wrong than a filter that is unit-tested against the authorization policy.
 * - Chunk-level records: one Search document per NOVA document chunk.
 * - The vector dimension is NOT a constant. It is taken from the configured
 *   embedding width so the index can never disagree with the provider.
 */
import { SearchError, type SearchClient } from "../../azure/search.ts"

/**
 * Bump when the field set changes. The code knows which schema it expects, so a
 * future field addition is a deliberate migration rather than a silent change
 * to a production index.
 */
export const NOVA_SEARCH_INDEX_VERSION = 1

export const VECTOR_FIELD = "contentVector"
const VECTOR_PROFILE = "nova-vector-profile"
const HNSW_CONFIG = "nova-hnsw"

/** Fields NOVA reads back. `contentVector` is deliberately absent: vectors never leave Search. */
export const RETRIEVAL_SELECT_FIELDS = [
	"id",
	"tenantId",
	"documentId",
	"versionId",
	"chunkId",
	"title",
	"filename",
	"content",
	"category",
	"sourceType",
	"department",
	"classification",
	"classificationLevel",
	"version",
	"section",
	"seq",
	"page",
	"uploadedBy",
	"uploadedAt",
	"effectiveDate",
	"injectionFlags",
	"contentHash",
	"metadataHash",
	"schemaVersion",
] as const

export type NovaSearchDocument = {
	/** Key: Azure keys allow only letters, digits, _, - and =; see searchDocumentKey(). */
	id: string
	tenantId: string
	documentId: string
	versionId: string
	chunkId: string
	title: string
	filename: string
	content: string
	category: string
	sourceType: string
	department: string
	classification: string
	classificationLevel: number
	allowedRoles: string[]
	allowedUsers: string[]
	documentActive: boolean
	versionActive: boolean
	version: string
	section: string
	seq: number
	/** Null when NOVA has no real page metadata. Never fabricated. */
	page: number | null
	uploadedBy: string
	uploadedAt: string | null
	effectiveDate: string | null
	injectionFlags: string[]
	contentHash: string
	metadataHash: string
	schemaVersion: number
	[VECTOR_FIELD]?: number[]
}

/**
 * Azure AI Search document keys are restricted to letters, digits, `_`, `-` and
 * `=`. NOVA chunk ids (`chk_<uuid>`) already satisfy that, but the transform is
 * applied anyway so an unusual id can never produce an unindexable document.
 * It is injective for NOVA's id space: only out-of-alphabet bytes are encoded.
 */
export function searchDocumentKey(tenantId: string, chunkId: string): string {
	return `${tenantId}__${chunkId}`.replace(/[^A-Za-z0-9_\-=]/g, (c) => `-${c.charCodeAt(0).toString(16)}-`)
}

/** The index definition NOVA expects for a given embedding width. */
export function buildIndexDefinition(name: string, dimensions: number): Record<string, unknown> {
	if (!Number.isInteger(dimensions) || dimensions <= 0) {
		throw new SearchError(`Invalid embedding dimension ${dimensions}`, 500, "bad_request")
	}
	const text = (field: string, extra: Record<string, unknown> = {}) => ({
		name: field,
		type: "Edm.String",
		searchable: true,
		filterable: false,
		sortable: false,
		facetable: false,
		analyzer: "standard.lucene",
		...extra,
	})
	const keyword = (field: string, extra: Record<string, unknown> = {}) => ({
		name: field,
		type: "Edm.String",
		searchable: false,
		filterable: true,
		sortable: false,
		facetable: false,
		...extra,
	})
	return {
		name,
		fields: [
			{ name: "id", type: "Edm.String", key: true, searchable: false, filterable: true, sortable: false, facetable: false },

			// --- security / filtering ---
			keyword("tenantId"),
			keyword("documentId"),
			keyword("versionId"),
			keyword("chunkId"),
			keyword("department"),
			keyword("classification"),
			{ name: "classificationLevel", type: "Edm.Int32", searchable: false, filterable: true, sortable: false, facetable: false },
			{ name: "allowedRoles", type: "Collection(Edm.String)", searchable: false, filterable: true, sortable: false, facetable: false },
			{ name: "allowedUsers", type: "Collection(Edm.String)", searchable: false, filterable: true, sortable: false, facetable: false },
			{ name: "documentActive", type: "Edm.Boolean", searchable: false, filterable: true, sortable: false, facetable: false },
			{ name: "versionActive", type: "Edm.Boolean", searchable: false, filterable: true, sortable: false, facetable: false },

			// --- full text ---
			text("content"),
			text("title"),
			text("section"),
			text("filename", { analyzer: "keyword" }),

			// --- citation metadata ---
			keyword("category"),
			keyword("sourceType"),
			keyword("version"),
			{ name: "seq", type: "Edm.Int32", searchable: false, filterable: true, sortable: true, facetable: false },
			{ name: "page", type: "Edm.Int32", searchable: false, filterable: false, sortable: false, facetable: false },
			keyword("uploadedBy"),
			{ name: "uploadedAt", type: "Edm.DateTimeOffset", searchable: false, filterable: true, sortable: true, facetable: false },
			{ name: "effectiveDate", type: "Edm.DateTimeOffset", searchable: false, filterable: true, sortable: true, facetable: false },
			{ name: "injectionFlags", type: "Collection(Edm.String)", searchable: false, filterable: true, sortable: false, facetable: false },

			// --- change detection / schema bookkeeping ---
			keyword("contentHash"),
			keyword("metadataHash"),
			{ name: "schemaVersion", type: "Edm.Int32", searchable: false, filterable: true, sortable: false, facetable: false },

			// --- vector ---
			{
				name: VECTOR_FIELD,
				type: "Collection(Edm.Single)",
				searchable: true,
				filterable: false,
				sortable: false,
				facetable: false,
				retrievable: false,
				dimensions,
				vectorSearchProfile: VECTOR_PROFILE,
			},
		],
		vectorSearch: {
			algorithms: [
				{
					name: HNSW_CONFIG,
					kind: "hnsw",
					// Defaults tuned for a small/medium corpus on the Free tier.
					// text-embedding-3-small vectors are normalised, so cosine is the
					// metric that matches the local store's cosine() scoring.
					hnswParameters: { m: 4, efConstruction: 400, efSearch: 500, metric: "cosine" },
				},
			],
			profiles: [{ name: VECTOR_PROFILE, algorithm: HNSW_CONFIG }],
		},
	}
}

export type IndexValidation = {
	exists: boolean
	compatible: boolean
	problems: string[]
	actualDimensions: number | null
	expectedDimensions: number
	fieldCount: number
}

/**
 * Compares the live index against what this build expects.
 *
 * Deliberately a compatibility check, not an equality check: extra fields added
 * by a newer build are tolerated, but a missing field, a changed type, a lost
 * filterable flag on a security field, or a vector-dimension mismatch is not.
 */
export function validateIndexDefinition(actual: any | null, expected: Record<string, any>): IndexValidation {
	const expectedFields: any[] = expected.fields
	const expectedDimensions = expectedFields.find((f) => f.name === VECTOR_FIELD)?.dimensions ?? 0
	if (!actual) {
		return { exists: false, compatible: false, problems: ["index does not exist"], actualDimensions: null, expectedDimensions, fieldCount: 0 }
	}
	const problems: string[] = []
	const byName = new Map<string, any>((actual.fields ?? []).map((f: any) => [f.name, f]))
	for (const want of expectedFields) {
		const got = byName.get(want.name)
		if (!got) {
			problems.push(`missing field "${want.name}"`)
			continue
		}
		if (got.type !== want.type) problems.push(`field "${want.name}" has type ${got.type}, expected ${want.type}`)
		if (want.key && !got.key) problems.push(`field "${want.name}" is not the key field`)
		// Security-relevant capabilities: losing one of these silently disables a filter.
		if (want.filterable && !got.filterable) problems.push(`field "${want.name}" is not filterable`)
		if (want.searchable && !got.searchable) problems.push(`field "${want.name}" is not searchable`)
		if (want.dimensions && got.dimensions !== want.dimensions) {
			problems.push(`vector field "${want.name}" has ${got.dimensions} dimensions, expected ${want.dimensions}`)
		}
	}
	const actualDimensions = byName.get(VECTOR_FIELD)?.dimensions ?? null
	return {
		exists: true,
		compatible: problems.length === 0,
		problems,
		actualDimensions,
		expectedDimensions,
		fieldCount: (actual.fields ?? []).length,
	}
}

export type EnsureIndexResult = { action: "created" | "reused"; validation: IndexValidation }

/**
 * Creates the index when it is absent, reuses it when it is compatible, and
 * raises a clear configuration error when it exists but is incompatible.
 *
 * It never drops or recreates an existing index: that would destroy indexed
 * data and silently discard the embeddings that were paid for. This is called
 * by the search:* commands, never from application startup.
 */
export async function ensureIndex(client: SearchClient, dimensions: number): Promise<EnsureIndexResult> {
	const expected = buildIndexDefinition(client.index, dimensions)
	const actual = await client.getIndex()
	if (!actual) {
		await client.createOrUpdateIndex(expected)
		const created = await client.getIndex()
		return { action: "created", validation: validateIndexDefinition(created, expected) }
	}
	const validation = validateIndexDefinition(actual, expected)
	if (!validation.compatible) {
		throw new SearchError(
			`Azure AI Search index "${client.index}" exists but is incompatible with NOVA schema v${NOVA_SEARCH_INDEX_VERSION}: ` +
				`${validation.problems.join("; ")}. Refusing to modify it automatically; migrate deliberately or use a new AZURE_SEARCH_INDEX name.`,
			500,
			"conflict",
		)
	}
	return { action: "reused", validation }
}
