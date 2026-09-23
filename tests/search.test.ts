/**
 * Phase 4 - Azure AI Search.
 *
 * Two layers:
 *
 * 1. Offline tests (always run): OData escaping and filter construction, index
 *    schema and dimension validation, REST client retry/error/redaction
 *    behaviour, change detection, and the incremental indexer driven against a
 *    fake store. No network, no credentials, no model calls.
 *
 * 2. Live tests (run only when AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_ADMIN_KEY
 *    are present): a throwaway index on the real service. These are the real
 *    proof that the generated OData filter means what the authorization policy
 *    means, because Azure's own OData engine evaluates it. Every authorization
 *    case is asserted against decideDocumentAccess() as the oracle.
 *
 * Embedding cost: the live tests use the deterministic LOCAL embedding provider.
 * They never call nova-embedding, so running this suite costs no Azure tokens.
 */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { after, before, describe, test } from "node:test"

import { SearchClient, SearchError, publicStatusForSearch } from "../backend/src/azure/search.ts"
import {
	NOVA_SEARCH_INDEX_VERSION,
	RETRIEVAL_SELECT_FIELDS,
	VECTOR_FIELD,
	buildIndexDefinition,
	ensureIndex,
	searchDocumentKey,
	validateIndexDefinition,
} from "../backend/src/retrieval/vector/azure-index.ts"
import { AzureVectorStore, contentHashOf, metadataHashOf, toSearchDocument } from "../backend/src/retrieval/vector/azure.ts"
import { buildSecurityFilter, escapeODataString, odataLiteral } from "../backend/src/retrieval/vector/odata.ts"
import { decideDocumentAccess, type AccessScope } from "../backend/src/authorization/policy.ts"
import { CLASSIFICATION_LEVEL, type Classification } from "../backend/src/models/types.ts"
import { LocalEmbeddingProvider } from "../backend/src/embeddings/local.ts"
import type { VectorRecord } from "../backend/src/retrieval/vector/base.ts"

const ENDPOINT = (process.env.AZURE_SEARCH_ENDPOINT ?? "").trim()
const ADMIN_KEY = (process.env.AZURE_SEARCH_ADMIN_KEY ?? "").trim()
const liveSkip = ENDPOINT && ADMIN_KEY ? false : "AZURE_SEARCH_ENDPOINT / AZURE_SEARCH_ADMIN_KEY are not set"
const DIM = 384

function scope(overrides: Partial<AccessScope> = {}): AccessScope {
	const grants = overrides.grants ?? { "*": CLASSIFICATION_LEVEL.public }
	return {
		tenantId: "ten_a",
		userId: "usr_1",
		roleKey: "EMPLOYEE",
		isAdmin: false,
		canUploadKnowledge: false,
		canCreateIncidents: true,
		// Phase 8 added action grants to AccessScope. Retrieval never reads them,
		// but the type is the whole scope, so the fixture supplies them.
		actionPermissions: [],
		grants,
		maxLevelAnywhere: Math.max(...Object.values(grants)),
		department: "Engineering",
		...overrides,
	}
}

/* ============================== OData filters ============================= */

describe("odata escaping", () => {
	test("doubles single quotes so a literal cannot be terminated", () => {
		assert.equal(escapeODataString("O'Brien"), "O''Brien")
		assert.equal(odataLiteral("O'Brien"), "'O''Brien'")
	})

	test("a filter-injection attempt stays inside the literal", () => {
		const evil = "ten_a' or tenantId ne 'x"
		const filter = buildSecurityFilter(scope({ tenantId: evil }))
		assert.ok(filter.includes("'ten_a'' or tenantId ne ''x'"), filter)
		// The number of quote-delimited regions must be even: nothing escaped the literal.
		assert.equal((filter.match(/'/g) ?? []).length % 2, 0)
		assert.ok(!/\bor tenantId ne\b/.test(filter.replace(/'[^']*(?:''[^']*)*'/g, "")), "injected operator leaked into the expression")
	})

	test("control characters are rejected rather than encoded", () => {
		assert.throws(() => escapeODataString("bad\u0000value"), /control character/i)
		assert.throws(() => buildSecurityFilter(scope({ roleKey: "ROLE\u001b" })), /control character/i)
	})

	test("malicious values in every security field are neutralised", () => {
		for (const field of ["tenantId", "userId", "roleKey"] as const) {
			const filter = buildSecurityFilter(scope({ [field]: "x' or true or '" } as any))
			assert.equal((filter.match(/'/g) ?? []).length % 2, 0, `${field} broke quoting`)
		}
		const filter = buildSecurityFilter(scope({ grants: { "Fin'ance": 4, "*": 1 } }))
		assert.ok(filter.includes("'Fin''ance'"))
	})
})

describe("security filter construction", () => {
	test("always constrains the tenant and the active flags", () => {
		const filter = buildSecurityFilter(scope())
		assert.ok(filter.startsWith("tenantId eq 'ten_a' and "), filter)
		assert.ok(filter.includes("documentActive eq true"))
		assert.ok(filter.includes("versionActive eq true"))
	})

	test("an admin is bounded by the tenant, with no ACL clause", () => {
		const filter = buildSecurityFilter(scope({ isAdmin: true }))
		assert.ok(filter.includes("tenantId eq 'ten_a'"))
		assert.ok(!filter.includes("allowedRoles"), filter)
		assert.ok(!filter.includes("classificationLevel"), filter)
	})

	test("a non-admin gets the user grant, per-department reach and the role ACL", () => {
		const filter = buildSecurityFilter(scope({ grants: { "*": 1, Engineering: 3 } }))
		assert.ok(filter.includes("allowedUsers/any(u: u eq 'usr_1')"))
		assert.ok(filter.includes("classificationLevel le 1"))
		assert.ok(filter.includes("(department eq 'Engineering' and classificationLevel le 3)"))
		assert.ok(filter.includes("not allowedRoles/any() or allowedRoles/any(r: r eq 'EMPLOYEE')"))
	})

	test("clearance is per department, never the global maximum", () => {
		// The pre-Phase-4 implementation applied maxLevelAnywhere to every
		// department, which leaked restricted HR content to a Finance-cleared user.
		const filter = buildSecurityFilter(scope({ grants: { "*": 1, Finance: 4 } }))
		assert.ok(filter.includes("(department eq 'Finance' and classificationLevel le 4)"))
		assert.ok(!filter.includes("classificationLevel le 4 or"), "level 4 must stay bound to Finance")
		assert.match(filter, /classificationLevel le 1/)
	})

	test("onlyActive:false keeps historical versions reachable for explicit requests", () => {
		const filter = buildSecurityFilter(scope(), { onlyActive: false })
		assert.ok(!filter.includes("versionActive"))
	})

	test("negate selects what the caller may NOT see, and nothing for an admin", () => {
		assert.ok(buildSecurityFilter(scope(), { negate: true }).includes("not ("))
		assert.ok(buildSecurityFilter(scope({ isAdmin: true }), { negate: true }).includes("false"))
	})

	test("department hints narrow but never widen", () => {
		const base = buildSecurityFilter(scope())
		const hinted = buildSecurityFilter(scope(), { departments: ["Engineering"] })
		assert.ok(hinted.startsWith(base))
		assert.ok(hinted.endsWith("and (department eq 'Engineering')"))
	})
})

/* ============================== index schema ============================== */

describe("index schema", () => {
	const definition = buildIndexDefinition("nova-knowledge", DIM) as any
	const byName = new Map<string, any>(definition.fields.map((f: any) => [f.name, f]))

	test("uses one key field and the configured vector width", () => {
		assert.equal(definition.fields.filter((f: any) => f.key).length, 1)
		assert.equal(byName.get("id").key, true)
		assert.equal(byName.get(VECTOR_FIELD).dimensions, DIM)
		assert.equal(byName.get(VECTOR_FIELD).retrievable, false, "vectors must never be returned")
	})

	test("every security field is filterable", () => {
		for (const field of ["tenantId", "department", "classification", "classificationLevel", "allowedRoles", "allowedUsers", "documentActive", "versionActive", "documentId", "versionId"]) {
			assert.equal(byName.get(field)?.filterable, true, `${field} must be filterable`)
		}
		assert.equal(byName.get("allowedRoles").type, "Collection(Edm.String)")
		assert.equal(byName.get("allowedUsers").type, "Collection(Edm.String)")
	})

	test("text fields are searchable and vectors use cosine", () => {
		for (const field of ["content", "title", "section", "filename"]) {
			assert.equal(byName.get(field)?.searchable, true, `${field} must be searchable`)
		}
		assert.equal(definition.vectorSearch.algorithms[0].hnswParameters.metric, "cosine")
		assert.equal(definition.vectorSearch.algorithms[0].kind, "hnsw")
	})

	test("the retrieval projection never includes the vector", () => {
		assert.ok(!RETRIEVAL_SELECT_FIELDS.includes(VECTOR_FIELD as never))
		assert.ok(!RETRIEVAL_SELECT_FIELDS.includes("allowedUsers" as never), "ACL lists are not needed by the caller")
	})

	test("rejects a nonsensical dimension instead of creating a broken index", () => {
		assert.throws(() => buildIndexDefinition("x", 0), SearchError)
		assert.throws(() => buildIndexDefinition("x", 1.5), SearchError)
	})

	test("document keys only use characters Azure accepts", () => {
		const key = searchDocumentKey("ten_a", "chk_9f2c-1e")
		assert.match(key, /^[A-Za-z0-9_\-=]+$/)
		assert.match(searchDocumentKey("ten a", "chk/1"), /^[A-Za-z0-9_\-=]+$/)
		assert.notEqual(searchDocumentKey("ten_a", "c1"), searchDocumentKey("ten_b", "c1"), "keys must be tenant-scoped")
	})
})

describe("index validation", () => {
	const expected = buildIndexDefinition("nova-knowledge", DIM) as any

	test("a missing index is reported, not silently created", () => {
		const v = validateIndexDefinition(null, expected)
		assert.equal(v.exists, false)
		assert.equal(v.compatible, false)
	})

	test("an identical index is compatible and reused", () => {
		const v = validateIndexDefinition(expected, expected)
		assert.deepEqual(v.problems, [])
		assert.equal(v.compatible, true)
	})

	test("extra fields from a newer build are tolerated", () => {
		const actual = { ...expected, fields: [...expected.fields, { name: "futureField", type: "Edm.String" }] }
		assert.equal(validateIndexDefinition(actual, expected).compatible, true)
	})

	test("a vector dimension mismatch is a hard incompatibility", () => {
		const actual = { ...expected, fields: expected.fields.map((f: any) => (f.name === VECTOR_FIELD ? { ...f, dimensions: 1536 } : f)) }
		const v = validateIndexDefinition(actual, expected)
		assert.equal(v.compatible, false)
		assert.equal(v.actualDimensions, 1536)
		assert.ok(v.problems.some((p) => /1536 dimensions, expected 384/.test(p)))
	})

	test("losing filterable on a security field is an incompatibility", () => {
		const actual = { ...expected, fields: expected.fields.map((f: any) => (f.name === "tenantId" ? { ...f, filterable: false } : f)) }
		assert.ok(validateIndexDefinition(actual, expected).problems.some((p) => /tenantId" is not filterable/.test(p)))
	})

	test("a missing field is an incompatibility", () => {
		const actual = { ...expected, fields: expected.fields.filter((f: any) => f.name !== "allowedUsers") }
		assert.ok(validateIndexDefinition(actual, expected).problems.some((p) => /missing field "allowedUsers"/.test(p)))
	})
})

/* =============================== rest client ============================== */

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	} as unknown as Response
}

function clientWith(responses: Array<() => Response | Promise<Response>>, key = "super-secret-admin-key") {
	const calls: Array<{ url: string; init: any }> = []
	let i = 0
	const client = new SearchClient({
		endpoint: "https://example.search.windows.net",
		index: "nova-knowledge",
		apiKey: key,
		maxRetries: 2,
		sleepImpl: async () => {},
		fetchImpl: (async (url: any, init: any) => {
			calls.push({ url: String(url), init })
			const next = responses[Math.min(i, responses.length - 1)]
			i += 1
			return next()
		}) as unknown as typeof fetch,
	})
	return { client, calls }
}

describe("search rest client", () => {
	test("sends the key only as a header, never in the URL", async () => {
		const { client, calls } = clientWith([() => fakeResponse(200, { value: [] })])
		await client.search({ search: "*" })
		assert.equal(calls[0].init.headers["api-key"], "super-secret-admin-key")
		assert.ok(!calls[0].url.includes("super-secret-admin-key"))
		assert.ok(calls[0].url.includes("api-version=2024-07-01"), "must use the stable API version")
	})

	test("retries transient failures with bounded attempts", async () => {
		let n = 0
		const { client } = clientWith([
			() => {
				n += 1
				return n <= 2 ? fakeResponse(503, "temporarily unavailable") : fakeResponse(200, { value: [{ id: "a" }] })
			},
		])
		const result = await client.search({ search: "*" })
		assert.equal(n, 3)
		assert.equal(result.value.length, 1)
	})

	test("honours 429 and eventually surfaces a rate_limit error", async () => {
		const { client } = clientWith([() => fakeResponse(429, "throttled", { "retry-after": "0" })])
		await assert.rejects(
			() => client.search({ search: "*" }),
			(error: unknown) => error instanceof SearchError && error.category === "rate_limit" && error.statusCode === 429,
		)
	})

	test("does NOT retry a bad filter or an auth failure", async () => {
		for (const [status, category] of [
			[400, "bad_request"],
			[401, "auth"],
			[403, "auth"],
		] as Array<[number, string]>) {
			let n = 0
			const { client } = clientWith([
				() => {
					n += 1
					return fakeResponse(status, "nope")
				},
			])
			await assert.rejects(() => client.search({ search: "*" }), SearchError)
			assert.equal(n, 1, `status ${status} must not be retried`)
			const error = await client.search({ search: "*" }).catch((e) => e)
			assert.equal(error.category, category)
		}
	})

	test("a 404 from getIndex means absent, not an error", async () => {
		const { client } = clientWith([() => fakeResponse(404, "not found")])
		assert.equal(await client.getIndex(), null)
	})

	test("the admin key never appears in an error message", async () => {
		const key = "super-secret-admin-key"
		const { client } = clientWith([() => fakeResponse(400, `bad request with api-key: ${key} echoed back`)], key)
		const error = (await client.search({ search: "*" }).catch((e) => e)) as SearchError
		assert.ok(!error.message.includes(key), error.message)
		assert.ok(!error.diagnostic.includes(key))
		assert.ok(error.message.includes("***"))
	})

	test("upstream auth/not-found statuses are not echoed to callers verbatim", () => {
		assert.equal(publicStatusForSearch({ category: "auth" }), 502)
		assert.equal(publicStatusForSearch({ category: "not_found" }), 502)
		assert.equal(publicStatusForSearch({ category: "rate_limit" }), 429)
		assert.equal(publicStatusForSearch({ category: "timeout" }), 504)
	})

	test("missing configuration fails fast", () => {
		assert.throws(() => new SearchClient({ endpoint: "", index: "i", apiKey: "k" }), SearchError)
		assert.throws(() => new SearchClient({ endpoint: "https://e", index: "", apiKey: "k" }), SearchError)
		assert.throws(() => new SearchClient({ endpoint: "https://e", index: "i", apiKey: "" }), SearchError)
	})
})

/* ============================ change detection ============================ */

function record(overrides: Partial<VectorRecord> = {}): VectorRecord {
	return {
		chunkId: "chk_1",
		tenantId: "ten_a",
		documentId: "doc_1",
		versionId: "ver_1",
		embedding: new Float32Array(DIM),
		text: "Expenses over 500 need approval.",
		section: "Purchase Approval",
		seq: 0,
		keywords: "",
		injectionFlags: [],
		documentTitle: "Expense Policy",
		department: "Finance",
		category: "policy",
		classification: "internal" as Classification,
		version: "2026.2",
		filename: "expense.pdf",
		sourceType: "pdf",
		allowedRoles: [],
		allowedUsers: [],
		documentActive: true,
		versionActive: true,
		uploadedBy: "ada@example.com",
		uploadedAt: "2026-01-01T00:00:00.000Z",
		effectiveDate: "2026-01-01T00:00:00.000Z",
		page: null,
		...overrides,
	}
}

describe("change detection", () => {
	test("identical content produces an identical content hash", () => {
		assert.equal(contentHashOf(record()), contentHashOf(record()))
	})

	test("changed text or title invalidates the embedding", () => {
		assert.notEqual(contentHashOf(record()), contentHashOf(record({ text: "different" })))
		assert.notEqual(contentHashOf(record()), contentHashOf(record({ documentTitle: "Other" })))
	})

	test("metadata changes do NOT invalidate the embedding", () => {
		const changed = record({ classification: "restricted" as Classification, allowedRoles: ["ADMIN"], versionActive: false })
		assert.equal(contentHashOf(record()), contentHashOf(changed), "metadata must not force a re-embed")
		assert.notEqual(metadataHashOf(record()), metadataHashOf(changed))
	})

	test("ACL ordering is not a change", () => {
		assert.equal(
			metadataHashOf(record({ allowedRoles: ["A", "B"] })),
			metadataHashOf(record({ allowedRoles: ["B", "A"] })),
		)
	})

	test("the mapped search document carries full citation metadata and no secrets", () => {
		const doc = toSearchDocument(record()) as Record<string, unknown>
		assert.equal(doc.documentId, "doc_1")
		assert.equal(doc.versionId, "ver_1")
		assert.equal(doc.chunkId, "chk_1")
		assert.equal(doc.title, "Expense Policy")
		assert.equal(doc.version, "2026.2")
		assert.equal(doc.section, "Purchase Approval")
		assert.equal(doc.page, null, "page must be null, never fabricated")
		assert.equal(doc.classificationLevel, CLASSIFICATION_LEVEL.internal)
		assert.equal(doc.schemaVersion, NOVA_SEARCH_INDEX_VERSION)
		assert.ok(!(VECTOR_FIELD in doc), "toSearchDocument must not embed the vector")
	})
})

/* ========================= store guards (offline) ========================= */

describe("azure vector store guards", () => {
	const store = new AzureVectorStore({ endpoint: "https://example.search.windows.net", index: "nova-knowledge", apiKey: "k", dimensions: DIM })

	test("refuses to query without a server-resolved scope", async () => {
		await assert.rejects(
			() => store.search(new Float32Array(DIM), ["q"], { tenantId: "ten_a" }, 5),
			(error: unknown) => error instanceof SearchError && /AccessScope/.test((error as Error).message),
		)
	})

	test("refuses a scope whose tenant disagrees with the query filter", async () => {
		await assert.rejects(
			() => store.search(new Float32Array(DIM), ["q"], { tenantId: "ten_b", scope: scope() }, 5),
			(error: unknown) => error instanceof SearchError && /Tenant mismatch/.test((error as Error).message),
		)
	})

	test("refuses a query vector of the wrong width instead of padding or truncating", async () => {
		await assert.rejects(
			() => store.search(new Float32Array(1536), ["q"], { tenantId: "ten_a", scope: scope() }, 5),
			(error: unknown) => error instanceof SearchError && /1536.*expects 384|dimension mismatch/i.test((error as Error).message),
		)
	})

	test("refuses to index a chunk vector of the wrong width", async () => {
		await assert.rejects(
			() => store.upsert([record({ embedding: new Float32Array(10) })]),
			(error: unknown) => error instanceof SearchError && /Refusing to truncate or pad/.test((error as Error).message),
		)
	})

	test("healthCheck makes no network call", async () => {
		const result = await store.healthCheck()
		assert.equal(result.ok, true)
		assert.match(result.detail, /no live probe/i)
	})
})

/* =========================== live azure search ============================ */

describe("live azure ai search", { skip: liveSkip }, () => {
	const indexName = `nova-test-${crypto.randomBytes(5).toString("hex")}`
	const embeddings = new LocalEmbeddingProvider({ model: "nova-hashed-lexical-v1", dim: DIM })
	let store: AzureVectorStore

	/** The document matrix under test, in tenant ten_a unless stated. */
	const DOCS = [
		{ id: "open-eng", department: "Engineering", classification: "internal", roles: [] as string[], users: [] as string[], docActive: true, verActive: true },
		{ id: "public-hr", department: "Human Resources", classification: "public", roles: [], users: [], docActive: true, verActive: true },
		{ id: "restricted-fin", department: "Finance", classification: "restricted", roles: [], users: [], docActive: true, verActive: true },
		{ id: "role-locked", department: "Engineering", classification: "internal", roles: ["MANAGER"], users: [], docActive: true, verActive: true },
		{ id: "user-granted", department: "Finance", classification: "restricted", roles: ["MANAGER"], users: ["usr_1"], docActive: true, verActive: true },
		{ id: "inactive-doc", department: "Engineering", classification: "public", roles: [], users: [], docActive: false, verActive: true },
		{ id: "inactive-ver", department: "Engineering", classification: "public", roles: [], users: [], docActive: true, verActive: false },
	]

	function recordFor(d: (typeof DOCS)[number], tenantId = "ten_a", vector?: Float32Array): VectorRecord {
		return record({
			chunkId: `chk_${d.id}`,
			tenantId,
			documentId: `doc_${d.id}`,
			versionId: `ver_${d.id}`,
			documentTitle: `Title ${d.id}`,
			text: `procurement approval threshold document ${d.id}`,
			section: "Section One",
			department: d.department,
			classification: d.classification as Classification,
			allowedRoles: d.roles,
			allowedUsers: d.users,
			documentActive: d.docActive,
			versionActive: d.verActive,
			embedding: vector ?? new Float32Array(DIM),
		})
	}

	before(async () => {
		store = new AzureVectorStore({ endpoint: ENDPOINT, index: indexName, apiKey: ADMIN_KEY, dimensions: DIM })
		await ensureIndex(store.client, DIM)
		const records: VectorRecord[] = []
		for (const d of DOCS) {
			const vector = await embeddings.embedOne(`procurement approval threshold document ${d.id}`)
			records.push(recordFor(d, "ten_a", vector))
		}
		// Tenant B copy of an otherwise wide-open document.
		records.push(recordFor({ ...DOCS[0], id: "tenant-b-open" }, "ten_b", await embeddings.embedOne("procurement approval threshold tenant b")))
		await store.upsert(records)
		// Azure indexing is asynchronous; give it a moment to become queryable.
		for (let i = 0; i < 30; i += 1) {
			const n = await store.client.documentCount()
			if (n >= records.length) break
			await new Promise((r) => setTimeout(r, 1000))
		}
	})

	after(async () => {
		await store?.client.deleteIndex().catch(() => {})
	})

	async function visibleIds(s: AccessScope, opts: { query?: string; withVector?: boolean; limit?: number } = {}): Promise<string[]> {
		const query = opts.query ?? "procurement approval threshold"
		const vector = opts.withVector === false ? new Float32Array(0) : await embeddings.embedOne(query)
		const results = await store.search(vector, [query], { tenantId: s.tenantId, scope: s }, opts.limit ?? 50)
		return results.map((r) => r.documentId.replace(/^doc_/, "")).sort()
	}

	/** The oracle: what the NOVA authorization policy says, independent of Search. */
	function expectedIds(s: AccessScope): string[] {
		return DOCS.filter((d) => d.docActive && d.verActive)
			.filter((d) =>
				decideDocumentAccess(s, {
					tenantId: "ten_a",
					documentId: d.id,
					department: d.department,
					classification: d.classification as Classification,
					allowedRoles: d.roles,
					allowedUsers: d.users,
				}).allowed,
			)
			.map((d) => d.id)
			.sort()
	}

	test("the index was created with the expected schema", async () => {
		const validation = validateIndexDefinition(await store.client.getIndex(), buildIndexDefinition(indexName, DIM))
		assert.equal(validation.exists, true)
		assert.deepEqual(validation.problems, [])
		assert.equal(validation.actualDimensions, DIM)
	})

	test("ensureIndex is idempotent and reuses the existing index", async () => {
		const result = await ensureIndex(store.client, DIM)
		assert.equal(result.action, "reused")
	})

	test("ensureIndex refuses an incompatible index instead of dropping it", async () => {
		await assert.rejects(
			() => ensureIndex(store.client, 1536),
			(error: unknown) => error instanceof SearchError && /incompatible|Refusing to modify/.test((error as Error).message),
		)
		// The data is still there: nothing was destroyed by the failed check.
		assert.ok((await store.client.documentCount()) > 0)
	})

	test("keyword-only search returns authorized results", async () => {
		const ids = await visibleIds(scope({ isAdmin: true }), { withVector: false })
		assert.ok(ids.includes("open-eng"))
	})

	test("vector + keyword hybrid search returns authorized results", async () => {
		const ids = await visibleIds(scope({ isAdmin: true }))
		assert.deepEqual(ids, ["open-eng", "public-hr", "restricted-fin", "role-locked", "user-granted"].sort())
	})

	test("top-K is respected", async () => {
		const query = "procurement approval threshold"
		const results = await store.search(await embeddings.embedOne(query), [query], { tenantId: "ten_a", scope: scope({ isAdmin: true }) }, 2)
		assert.equal(results.length, 2)
	})

	test("a keyword query with no match returns an empty result, not an error", async () => {
		// Keyword-only: a non-matching term must yield nothing.
		assert.deepEqual(await visibleIds(scope({ isAdmin: true }), { query: "zzzzqqqqnomatchtoken", withVector: false }), [])
		// A tenant with no content yields nothing even for a hybrid query. (A
		// hybrid query always returns the nearest vectors among the FILTERED set,
		// so "no results" comes from the filter, never from lexical mismatch.)
		assert.deepEqual(await visibleIds(scope({ isAdmin: true, tenantId: "ten_nonexistent" })), [])
	})

	test("inactive documents and inactive versions are never returned", async () => {
		const ids = await visibleIds(scope({ isAdmin: true }))
		assert.ok(!ids.includes("inactive-doc"), "inactive document leaked")
		assert.ok(!ids.includes("inactive-ver"), "inactive version leaked")
	})

	test("tenant A cannot retrieve tenant B content, and vice versa", async () => {
		const a = await visibleIds(scope({ isAdmin: true, tenantId: "ten_a" }))
		assert.ok(!a.includes("tenant-b-open"))
		const b = await visibleIds(scope({ isAdmin: true, tenantId: "ten_b" }))
		assert.deepEqual(b, ["tenant-b-open"])
	})

	test("a frontend-supplied tenant id cannot change the filter", async () => {
		// The store takes its tenant from the server-resolved AccessScope only.
		// Supplying a different tenantId in the filter is rejected outright.
		await assert.rejects(
			() => store.search(new Float32Array(DIM), ["x"], { tenantId: "ten_b", scope: scope({ isAdmin: true, tenantId: "ten_a" }) }, 10),
			(error: unknown) => error instanceof SearchError && /Tenant mismatch/.test((error as Error).message),
		)
		// And a hostile "department hint" can only ever narrow the result set.
		const ids = await visibleIds(scope({ isAdmin: true }))
		const narrowed = await store.search(
			await embeddings.embedOne("procurement"),
			["procurement"],
			{ tenantId: "ten_a", scope: scope({ isAdmin: true }), departments: ["' or tenantId ne 'x"] },
			50,
		)
		assert.equal(narrowed.length, 0, "an injected department hint must match nothing, not everything")
		assert.ok(ids.length > 0)
	})

	for (const [label, s] of [
		["public-only employee", scope({ grants: { "*": CLASSIFICATION_LEVEL.public } })],
		["internal employee", scope({ grants: { "*": CLASSIFICATION_LEVEL.internal } })],
		["finance-restricted analyst", scope({ grants: { "*": CLASSIFICATION_LEVEL.public, Finance: CLASSIFICATION_LEVEL.restricted } })],
		["manager role", scope({ roleKey: "MANAGER", grants: { "*": CLASSIFICATION_LEVEL.internal } })],
		["explicitly granted user", scope({ userId: "usr_1", grants: { "*": CLASSIFICATION_LEVEL.public } })],
		["other user", scope({ userId: "usr_other", grants: { "*": CLASSIFICATION_LEVEL.public } })],
		["admin", scope({ isAdmin: true })],
	] as Array<[string, AccessScope]>) {
		test(`azure results match the NOVA authorization policy exactly: ${label}`, async () => {
			assert.deepEqual(await visibleIds(s), expectedIds(s), label)
		})
	}

	test("an unauthorized role cannot reach role-locked content, an allowed role can", async () => {
		const employee = await visibleIds(scope({ roleKey: "EMPLOYEE", grants: { "*": CLASSIFICATION_LEVEL.internal } }))
		assert.ok(!employee.includes("role-locked"))
		const manager = await visibleIds(scope({ roleKey: "MANAGER", grants: { "*": CLASSIFICATION_LEVEL.internal } }))
		assert.ok(manager.includes("role-locked"))
	})

	test("an explicit user grant beats both classification and the role ACL", async () => {
		const granted = await visibleIds(scope({ userId: "usr_1", grants: { "*": CLASSIFICATION_LEVEL.public } }))
		assert.ok(granted.includes("user-granted"), "explicit user grant must win")
		const other = await visibleIds(scope({ userId: "usr_other", grants: { "*": CLASSIFICATION_LEVEL.public } }))
		assert.ok(!other.includes("user-granted"))
	})

	test("clearance does not leak across departments", async () => {
		const financeAnalyst = scope({ grants: { "*": CLASSIFICATION_LEVEL.public, Finance: CLASSIFICATION_LEVEL.restricted } })
		const ids = await visibleIds(financeAnalyst)
		assert.ok(ids.includes("restricted-fin"), "should see restricted Finance content")
		assert.ok(!ids.includes("open-eng"), "internal Engineering content is above a public grant there")
	})

	test("results carry traceable citation metadata and no vector", async () => {
		const query = "procurement approval threshold"
		const results = await store.search(await embeddings.embedOne(query), [query], { tenantId: "ten_a", scope: scope({ isAdmin: true }) }, 5)
		const hit = results.find((r) => r.documentId === "doc_open-eng")!
		assert.ok(hit, "expected the open document")
		assert.equal(hit.chunkId, "chk_open-eng")
		assert.equal(hit.versionId, "ver_open-eng")
		assert.equal(hit.documentTitle, "Title open-eng")
		assert.equal(hit.version, "2026.2")
		assert.equal(hit.section, "Section One")
		assert.equal(hit.page, null)
		assert.equal(hit.embedding.length, 0, "vectors must never leave Search")
		assert.ok(hit.vectorScore > 0)
	})

	test("the out-of-scope probe returns a count only", async () => {
		const limited = scope({ grants: { "*": CLASSIFICATION_LEVEL.public } })
		const count = await store.countMatchingOutsideScope(["procurement approval threshold"], { tenantId: "ten_a", scope: limited })
		assert.equal(typeof count, "number")
		assert.ok(count > 0, "restricted material exists beyond a public-only clearance")
		assert.equal(await store.countMatchingOutsideScope(["procurement"], { tenantId: "ten_a", scope: scope({ isAdmin: true }) }), 0)
	})

	test("deactivating a version removes it from retrieval without re-embedding", async () => {
		const before = await visibleIds(scope({ isAdmin: true }))
		assert.ok(before.includes("open-eng"))
		await store.setActiveFlags("ten_a", { versionId: "ver_open-eng" }, { versionActive: false })
		await new Promise((r) => setTimeout(r, 2000))
		assert.ok(!(await visibleIds(scope({ isAdmin: true }))).includes("open-eng"), "deactivated version still retrievable")
		await store.setActiveFlags("ten_a", { versionId: "ver_open-eng" }, { versionActive: true })
		await new Promise((r) => setTimeout(r, 2000))
		assert.ok((await visibleIds(scope({ isAdmin: true }))).includes("open-eng"))
	})

	test("a metadata-only merge updates the ACL without touching the vector", async () => {
		await store.upsertMetadata([{ id: searchDocumentKey("ten_a", "chk_public-hr"), allowedRoles: ["MANAGER"] }])
		await new Promise((r) => setTimeout(r, 2000))
		const employee = await visibleIds(scope({ roleKey: "EMPLOYEE", grants: { "*": CLASSIFICATION_LEVEL.internal } }))
		assert.ok(!employee.includes("public-hr"), "tightened ACL must take effect immediately")
		await store.upsertMetadata([{ id: searchDocumentKey("ten_a", "chk_public-hr"), allowedRoles: [] }])
		await new Promise((r) => setTimeout(r, 2000))
	})

	test("deleting a document's chunks removes them from the index", async () => {
		await store.deleteByDocument("ten_a", "doc_public-hr")
		await new Promise((r) => setTimeout(r, 2000))
		assert.ok(!(await visibleIds(scope({ isAdmin: true }))).includes("public-hr"))
	})

	test("a malformed filter produces a safe, credential-free error", async () => {
		const error = (await store.client.search({ search: "*", filter: "this is not odata" }).catch((e) => e)) as SearchError
		assert.ok(error instanceof SearchError)
		assert.equal(error.category, "bad_request")
		assert.ok(!error.message.includes(ADMIN_KEY))
		assert.ok(!error.diagnostic.includes(ADMIN_KEY))
	})
})
