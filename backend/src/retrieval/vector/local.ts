/**
 * LocalVectorStore: chunk vectors live in SQLite alongside their metadata.
 *
 * Tenant isolation and the authorization predicate are part of the SQL WHERE
 * clause, so unauthorized or cross-tenant chunks are never loaded into memory,
 * let alone scored or sent to a model.
 */
import type { VectorQueryFilter, VectorRecord, VectorStore } from "./base.ts"
import type { Database } from "../../db/index.ts"
import { bufferToFloats, cosine, floatsToBuffer } from "../../embeddings/base.ts"
import { tokenize } from "../../embeddings/local.ts"

const SELECT_COLUMNS = `
	c.id AS chunk_id, c.tenant_id, c.document_id, c.version_id, c.seq, c.section, c.text,
	c.keywords, c.embedding, c.injection_flags,
	d.title AS document_title, d.department, d.category, d.classification,
	v.version AS version
`

function rowToRecord(row: any): VectorRecord {
	return {
		chunkId: row.chunk_id,
		tenantId: row.tenant_id,
		documentId: row.document_id,
		versionId: row.version_id,
		embedding: bufferToFloats(row.embedding),
		text: row.text,
		section: row.section,
		seq: row.seq,
		keywords: row.keywords,
		injectionFlags: JSON.parse(row.injection_flags || "[]"),
		documentTitle: row.document_title,
		department: row.department,
		category: row.category,
		classification: row.classification,
		version: row.version,
	}
}

export class LocalVectorStore implements VectorStore {
	readonly name = "LocalVectorStore"
	readonly mode = "local" as const

	constructor(private readonly db: Database) {}

	async upsert(records: VectorRecord[]): Promise<void> {
		for (const record of records) {
			this.db.run(
				`UPDATE document_chunks SET embedding = ?, keywords = ? WHERE id = ? AND tenant_id = ?`,
				floatsToBuffer(record.embedding),
				record.keywords,
				record.chunkId,
				record.tenantId,
			)
		}
	}

	async deleteByVersion(tenantId: string, versionId: string): Promise<void> {
		this.db.run(`DELETE FROM document_chunks WHERE tenant_id = ? AND version_id = ?`, tenantId, versionId)
	}

	async deleteByDocument(tenantId: string, documentId: string): Promise<void> {
		this.db.run(`DELETE FROM document_chunks WHERE tenant_id = ? AND document_id = ?`, tenantId, documentId)
	}

	private buildWhere(filter: VectorQueryFilter): { sql: string; params: any[] } {
		const clauses: string[] = []
		const params: any[] = []
		// Tenant isolation: enforced on both the chunk and its parent document.
		clauses.push("c.tenant_id = ?", "d.tenant_id = ?", "v.tenant_id = ?")
		params.push(filter.tenantId, filter.tenantId, filter.tenantId)
		clauses.push("d.status = 'active'")
		if (filter.onlyActiveVersions !== false) clauses.push("v.status = 'active'")
		if (filter.accessSql) {
			clauses.push(`(${filter.accessSql.sql})`)
			params.push(...filter.accessSql.params)
		}
		if (filter.departments?.length) {
			clauses.push(`d.department IN (${filter.departments.map(() => "?").join(", ")})`)
			params.push(...filter.departments)
		}
		return { sql: clauses.join(" AND "), params }
	}

	async search(
		queryVector: Float32Array,
		queryTerms: string[],
		filter: VectorQueryFilter,
		limit: number,
	): Promise<Array<VectorRecord & { vectorScore: number; keywordScore: number }>> {
		const where = this.buildWhere(filter)
		const rows = this.db.all(
			`SELECT ${SELECT_COLUMNS}
			   FROM document_chunks c
			   JOIN documents d ON d.id = c.document_id
			   JOIN document_versions v ON v.id = c.version_id
			  WHERE ${where.sql}`,
			...where.params,
		)

		// BM25-style keyword statistics computed over the authorized candidate set.
		const docFreq = new Map<string, number>()
		const termSets: Array<Set<string>> = []
		const lengths: number[] = []
		for (const row of rows) {
			const tokens = tokenize(`${row.section} ${row.text}`)
			const set = new Set(tokens)
			termSets.push(set)
			lengths.push(tokens.length || 1)
			for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
		}
		const avgLen = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1)
		const N = rows.length || 1
		const queryStems = tokenize(queryTerms.join(" "))

		const scored = rows.map((row, index) => {
			const record = rowToRecord(row)
			const vectorScore = queryVector.length ? Math.max(0, cosine(queryVector, record.embedding)) : 0
			let keywordScore = 0
			const tokens = tokenize(`${record.section} ${record.text}`)
			const tf = new Map<string, number>()
			for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
			for (const term of new Set(queryStems)) {
				const f = tf.get(term) ?? 0
				if (f === 0) continue
				const df = docFreq.get(term) ?? 1
				const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
				const k1 = 1.2
				const b = 0.75
				keywordScore += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * lengths[index]) / (avgLen || 1))))
			}
			return { ...record, vectorScore, keywordScore }
		})

		// Normalise keyword scores to 0..1 so hybrid weighting is meaningful.
		const maxKeyword = Math.max(0.0001, ...scored.map((s) => s.keywordScore))
		for (const item of scored) item.keywordScore = item.keywordScore / maxKeyword

		return scored
			.sort((a, b) => b.vectorScore + b.keywordScore - (a.vectorScore + a.keywordScore))
			.slice(0, limit)
	}

	/**
	 * Counts chunks in this tenant that match the query but fall OUTSIDE the
	 * caller's authorization scope. Returns a number only - no titles, no text -
	 * so a denial message can never leak confidential metadata.
	 */
	async countMatchingOutsideScope(queryTerms: string[], filter: VectorQueryFilter): Promise<number> {
		if (!filter.accessSql) return 0
		const terms = tokenize(queryTerms.join(" "))
		if (terms.length === 0) return 0
		const likeClauses = terms.map(() => `LOWER(c.text) LIKE ?`).join(" OR ")
		const params: any[] = [filter.tenantId, filter.tenantId, filter.tenantId]
		const row = this.db.get(
			`SELECT COUNT(*) AS n
			   FROM document_chunks c
			   JOIN documents d ON d.id = c.document_id
			   JOIN document_versions v ON v.id = c.version_id
			  WHERE c.tenant_id = ? AND d.tenant_id = ? AND v.tenant_id = ?
			    AND d.status = 'active' AND v.status = 'active'
			    AND NOT (${filter.accessSql.sql})
			    AND (${likeClauses})`,
			...params,
			...filter.accessSql.params,
			...terms.map((t) => `%${t}%`),
		)
		return Number(row?.n ?? 0)
	}

	async bestTermMatchOutsideScope(queryTerms: string[], filter: VectorQueryFilter): Promise<number> {
		if (!filter.accessSql) return 0
		const terms = [...new Set(tokenize(queryTerms.join(" ")))]
		if (terms.length === 0) return 0
		// One score expression per term: counts how many distinct query terms a single
		// unauthorized chunk contains. Only the number is returned, never the content.
		const scoreExpr = terms.map(() => `(CASE WHEN LOWER(c.text) LIKE ? THEN 1 ELSE 0 END)`).join(" + ")
		const row = this.db.get(
			`SELECT MAX(${scoreExpr}) AS best
			   FROM document_chunks c
			   JOIN documents d ON d.id = c.document_id
			   JOIN document_versions v ON v.id = c.version_id
			  WHERE c.tenant_id = ? AND d.tenant_id = ? AND v.tenant_id = ?
			    AND d.status = 'active' AND v.status = 'active'
			    AND NOT (${filter.accessSql.sql})`,
			...terms.map((t) => `%${t}%`),
			filter.tenantId,
			filter.tenantId,
			filter.tenantId,
			...filter.accessSql.params,
		)
		return Number(row?.best ?? 0)
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		const row = this.db.get(`SELECT COUNT(*) AS n FROM document_chunks WHERE embedding IS NOT NULL`)
		return { ok: true, detail: `Local SQLite vector store with ${row?.n ?? 0} indexed chunks.` }
	}
}
// hist: 2026-09-21T10:44:03+05:30
// hist: 2026-09-22T11:26:33+05:30
