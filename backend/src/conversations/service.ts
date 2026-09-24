/** Conversation + message persistence. Every row is tenant-scoped. */
import { randomUUID } from "node:crypto"
import type { Database } from "../db/index.ts"
import type { ActionRecord, Citation, Confidence, Conversation, Grounding, Message } from "../models/types.ts"

function rowToConversation(r: any): Conversation {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		userId: r.user_id,
		title: r.title,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}
}

export class ConversationService {
	constructor(private readonly db: Database) {}

	create(tenantId: string, userId: string, title = "New conversation"): Conversation {
		const id = `cnv_${randomUUID()}`
		const now = new Date().toISOString()
		this.db.run(
			`INSERT INTO conversations (id, tenant_id, user_id, title, state_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, '{}', ?, ?)`,
			id,
			tenantId,
			userId,
			title,
			now,
			now,
		)
		return rowToConversation(this.db.get(`SELECT * FROM conversations WHERE id = ? AND tenant_id = ?`, id, tenantId))
	}

	list(tenantId: string, userId: string, limit = 50): Conversation[] {
		return this.db
			.all(
				`SELECT * FROM conversations WHERE tenant_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?`,
				tenantId,
				userId,
				limit,
			)
			.map(rowToConversation)
	}

	get(tenantId: string, conversationId: string): Conversation | null {
		const row = this.db.get(`SELECT * FROM conversations WHERE id = ? AND tenant_id = ?`, conversationId, tenantId)
		return row ? rowToConversation(row) : null
	}

	/**
	 * Ownership-scoped read. Tenant match alone is NOT authorization: two people
	 * in the same workspace are different principals, so every caller that acts
	 * on "my conversation" must come through here rather than through get().
	 */
	getOwned(tenantId: string, userId: string, conversationId: string): Conversation | null {
		const row = this.db.get(
			`SELECT * FROM conversations WHERE id = ? AND tenant_id = ? AND user_id = ?`,
			conversationId,
			tenantId,
			userId,
		)
		return row ? rowToConversation(row) : null
	}

	/** True when the message belongs to a conversation this user owns. */
	ownsMessage(tenantId: string, userId: string, messageId: string): boolean {
		const row = this.db.get(
			`SELECT m.id AS id FROM messages m
			 JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
			 WHERE m.id = ? AND m.tenant_id = ? AND c.user_id = ?`,
			messageId,
			tenantId,
			userId,
		)
		return Boolean(row?.id)
	}

	rename(tenantId: string, conversationId: string, title: string): void {
		this.db.run(
			`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
			title.slice(0, 120),
			new Date().toISOString(),
			conversationId,
			tenantId,
		)
	}

	delete(tenantId: string, conversationId: string): void {
		this.db.run(
			`DELETE FROM citations WHERE tenant_id = ? AND message_id IN (SELECT id FROM messages WHERE tenant_id = ? AND conversation_id = ?)`,
			tenantId,
			tenantId,
			conversationId,
		)
		this.db.run(`DELETE FROM messages WHERE tenant_id = ? AND conversation_id = ?`, tenantId, conversationId)
		this.db.run(`DELETE FROM conversations WHERE tenant_id = ? AND id = ?`, tenantId, conversationId)
	}

	/** Multi-turn workflow state (e.g. a partially collected incident draft). */
	getState<T extends Record<string, unknown>>(tenantId: string, conversationId: string): T {
		const row = this.db.get(
			`SELECT state_json FROM conversations WHERE id = ? AND tenant_id = ?`,
			conversationId,
			tenantId,
		)
		try {
			return JSON.parse(row?.state_json || "{}") as T
		} catch {
			return {} as T
		}
	}

	setState(tenantId: string, conversationId: string, state: Record<string, unknown>): void {
		this.db.run(
			`UPDATE conversations SET state_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
			JSON.stringify(state),
			new Date().toISOString(),
			conversationId,
			tenantId,
		)
	}

	addMessage(input: {
		tenantId: string
		conversationId: string
		userId?: string
		role: "user" | "assistant"
		content: string
		grounding?: Grounding | null
		confidence?: Confidence | null
		provider?: string | null
		latencyMs?: number | null
		citations?: Citation[]
		action?: ActionRecord | null
	}): Message {
		const id = `msg_${randomUUID()}`
		const now = new Date().toISOString()
		this.db.run(
			`INSERT INTO messages (id, tenant_id, conversation_id, user_id, role, content, grounding, confidence,
				provider, latency_ms, action_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.tenantId,
			input.conversationId,
			input.userId ?? "",
			input.role,
			input.content,
			input.grounding ?? null,
			input.confidence ?? null,
			input.provider ?? null,
			input.latencyMs ?? null,
			input.action ? JSON.stringify(input.action) : null,
			now,
		)
		const citations = input.citations ?? []
		if (citations.length > 0) {
			// One multi-row parameterized INSERT instead of one network round trip per citation.
			// Values are pushed positionally into a flat params array — no string interpolation of data.
			const placeholderGroups = citations.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			const params: unknown[] = []
			for (const citation of citations) {
				params.push(
					`cit_${randomUUID()}`,
					input.tenantId,
					id,
					citation.documentId,
					citation.versionId,
					citation.chunkId,
					citation.documentTitle,
					citation.department,
					citation.version,
					citation.section,
					citation.score,
				)
			}
			this.db.run(
				`INSERT INTO citations (id, tenant_id, message_id, document_id, version_id, chunk_id,
					document_title, department, version, section, score)
				 VALUES ${placeholderGroups.join(", ")}`,
				...params,
			)
		}
		this.db.run(
			`UPDATE conversations SET updated_at = ? WHERE id = ? AND tenant_id = ?`,
			now,
			input.conversationId,
			input.tenantId,
		)
		// Return the message directly from the known inserted fields.
		// Previously this called this.messages() which reloaded the entire conversation
		// history and issued one citation SELECT per historical message (N+1 pattern).
		return {
			id,
			tenantId: input.tenantId,
			conversationId: input.conversationId,
			role: input.role,
			content: input.content,
			grounding: input.grounding ?? null,
			confidence: input.confidence ?? null,
			provider: input.provider ?? null,
			latencyMs: input.latencyMs ?? null,
			citations: citations.map((c, index) => ({
				index: index + 1,
				documentId: c.documentId,
				versionId: c.versionId,
				documentTitle: c.documentTitle,
				department: c.department,
				version: c.version,
				section: c.section,
				chunkId: c.chunkId,
				classification: "internal" as const,
				score: c.score,
			})),
			action: input.action ?? null,
			createdAt: now,
		}
	}

	messages(tenantId: string, conversationId: string): Message[] {
		const rows = this.db.all(
			`SELECT * FROM messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
			tenantId,
			conversationId,
		)
		return rows.map((r) => {
			const citations = this.db
				.all(
					`SELECT * FROM citations WHERE tenant_id = ? AND message_id = ? ORDER BY score DESC`,
					tenantId,
					r.id,
				)
				.map((c, index) => ({
					index: index + 1,
					documentId: c.document_id,
					versionId: c.version_id,
					documentTitle: c.document_title,
					department: c.department,
					version: c.version,
					section: c.section,
					chunkId: c.chunk_id,
					classification: "internal" as const,
					score: Number(c.score),
				}))
			return {
				id: r.id,
				tenantId: r.tenant_id,
				conversationId: r.conversation_id,
				role: r.role,
				content: r.content,
				grounding: r.grounding,
				confidence: r.confidence,
				provider: r.provider,
				latencyMs: r.latency_ms,
				citations,
				action: r.action_json ? JSON.parse(r.action_json) : null,
				createdAt: r.created_at,
			} as Message
		})
	}

	setFeedback(tenantId: string, messageId: string, feedback: "up" | "down" | null): void {
		this.db.run(`UPDATE messages SET feedback = ? WHERE tenant_id = ? AND id = ?`, feedback, tenantId, messageId)
	}

	metrics(tenantId: string) {
		const totals = this.db.get(
			`SELECT COUNT(*) AS queries, AVG(latency_ms) AS avg_latency FROM messages WHERE tenant_id = ? AND role = 'assistant'`,
			tenantId,
		)
		const grounded = this.db.get(
			`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND role = 'assistant' AND grounding IN ('grounded','partially_grounded')`,
			tenantId,
		)
		const denied = this.db.get(
			`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND grounding = 'access_denied'`,
			tenantId,
		)
		const conversations = this.db.get(`SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ?`, tenantId)
		const queries = Number(totals?.queries ?? 0)
		return {
			queries,
			conversations: Number(conversations?.n ?? 0),
			avgLatencyMs: Math.round(Number(totals?.avg_latency ?? 0)),
			citationRate: queries === 0 ? 0 : Math.round((Number(grounded?.n ?? 0) / queries) * 100),
			accessDenied: Number(denied?.n ?? 0),
		}
	}
}
// hist: 2026-09-21T19:23:51+05:30
// hist: 2026-09-24T08:41:33+05:30
// hist: 2026-09-24T09:04:58+05:30
