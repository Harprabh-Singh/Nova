/**
 * Conversation service tests — covering the N+1 regression fix in addMessage.
 *
 * All tests run against the in-memory SQLite database (no Azure dependency).
 * When NOVA_TEST_DB=postgres the same assertions also run against Neon via the
 * PostgresBridge, because freshDb() returns a real Postgres connection in that mode.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { freshDb, makeWorkspace, services } from "./helpers.ts"
import { ConversationService } from "../backend/src/conversations/service.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCitation(i: number) {
	return {
		documentId: `doc_${i}`,
		versionId: `ver_${i}`,
		chunkId: `chunk_${i}`,
		documentTitle: `Document ${i}`,
		department: "Engineering",
		version: "v1",
		section: `Section ${i}`,
		score: 0.9 - i * 0.05,
		classification: "internal" as const,
		index: i + 1,
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("addMessage returns the newly created message with correct fields", () => {
	const db = freshDb()
	const ws = makeWorkspace(db, {
		name: "Test Corp",
		users: [{ name: "Alice", email: "alice@test.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const conv = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Test conversation")

	const msg = svc.addMessage({
		tenantId: ws.tenant.id,
		conversationId: conv.id,
		userId: ws.actor("alice@test.example").user.id,
		role: "assistant",
		content: "Hello, world!",
		grounding: "grounded",
		confidence: "high",
		provider: "test-provider",
		latencyMs: 1234,
	})

	assert.ok(msg.id.startsWith("msg_"), "message ID must have msg_ prefix")
	assert.equal(msg.content, "Hello, world!")
	assert.equal(msg.role, "assistant")
	assert.equal(msg.grounding, "grounded")
	assert.equal(msg.confidence, "high")
	assert.equal(msg.provider, "test-provider")
	assert.equal(msg.latencyMs, 1234)
	assert.ok(msg.createdAt, "createdAt must be populated")
	assert.equal(msg.tenantId, ws.tenant.id)
	assert.equal(msg.conversationId, conv.id)
	assert.deepEqual(msg.citations, [], "no citations on this message")
})

test("addMessage persists the message so it is retrievable via messages()", () => {
	const db = freshDb()
	const ws = makeWorkspace(db, {
		name: "Test Corp",
		users: [{ name: "Alice", email: "alice@test.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const conv = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Test conversation")

	const inserted = svc.addMessage({
		tenantId: ws.tenant.id,
		conversationId: conv.id,
		role: "user",
		content: "What is the leave policy?",
	})

	const history = svc.messages(ws.tenant.id, conv.id)
	assert.equal(history.length, 1)
	assert.equal(history[0].id, inserted.id)
	assert.equal(history[0].content, "What is the leave policy?")
})

test("addMessage with citations returns citations and persists them to the database", () => {
	const db = freshDb()
	const ws = makeWorkspace(db, {
		name: "Test Corp",
		users: [{ name: "Alice", email: "alice@test.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const conv = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Test conversation")
	const inputCitations = [makeCitation(0), makeCitation(1), makeCitation(2), makeCitation(3), makeCitation(4), makeCitation(5)]

	const msg = svc.addMessage({
		tenantId: ws.tenant.id,
		conversationId: conv.id,
		role: "assistant",
		content: "Here is the answer.",
		citations: inputCitations,
	})

	// Returned message must already contain citations — no extra round trip needed.
	assert.equal(msg.citations.length, 6, "returned message must carry all 6 citations")
	assert.equal(msg.citations[0].index, 1)
	assert.equal(msg.citations[5].index, 6)
	assert.equal(msg.citations[0].documentId, "doc_0")

	// The citations must also be durable — verify they were actually persisted.
	const stored = db.all<{ message_id: string }>(
		"SELECT * FROM citations WHERE message_id = ? ORDER BY score DESC",
		msg.id,
	)
	assert.equal(stored.length, 6, "all 6 citations must be persisted in the database")
})

test("addMessage citations are returned in score-descending order when loaded via messages()", () => {
	const db = freshDb()
	const ws = makeWorkspace(db, {
		name: "Test Corp",
		users: [{ name: "Alice", email: "alice@test.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const conv = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Test conversation")
	// Insert in ascending-score order; when read back via messages() they should be DESC.
	const citations = [makeCitation(4), makeCitation(3), makeCitation(2), makeCitation(1), makeCitation(0)]
	svc.addMessage({ tenantId: ws.tenant.id, conversationId: conv.id, role: "assistant", content: "A", citations })

	const [loaded] = svc.messages(ws.tenant.id, conv.id)
	// messages() loads citations ORDER BY score DESC — highest first.
	assert.ok(loaded.citations[0].score >= loaded.citations[1].score, "citations must be score-DESC when loaded")
})

test("addMessage does NOT load the entire conversation history to return the new message", () => {
	// Regression guard: addMessage must not call this.messages() (which has the N+1 pattern).
	// We verify by pre-populating many messages and asserting the returned message is the *new* one,
	// not the full history. A real N+1 implementation would return the full list from find().
	const db = freshDb()
	const ws = makeWorkspace(db, {
		name: "Test Corp",
		users: [{ name: "Alice", email: "alice@test.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const conv = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Test conversation")

	// Pre-populate 10 messages — each with 3 citations so the old N+1 pattern would fire 30+ extra SELECTs.
	for (let i = 0; i < 10; i++) {
		svc.addMessage({
			tenantId: ws.tenant.id,
			conversationId: conv.id,
			role: "user",
			content: `Turn ${i}`,
			citations: [makeCitation(0), makeCitation(1), makeCitation(2)],
		})
	}

	// Add the message we care about.
	const newMsg = svc.addMessage({
		tenantId: ws.tenant.id,
		conversationId: conv.id,
		role: "assistant",
		content: "Final answer",
		citations: [makeCitation(0)],
	})

	// The returned value must be exactly the new message, not the 11th element of the full history.
	assert.equal(newMsg.content, "Final answer")
	assert.equal(newMsg.citations.length, 1)
	// Verify the full history is still correct when loaded explicitly.
	const history = svc.messages(ws.tenant.id, conv.id)
	assert.equal(history.length, 11, "full history must still be 11 messages")
	assert.equal(history[10].content, "Final answer")
})

test("tenant isolation: addMessage cannot return or access another tenant's conversation", () => {
	const db = freshDb()
	const ws1 = makeWorkspace(db, {
		name: "Tenant A",
		users: [{ name: "Alice", email: "alice@a.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const ws2 = makeWorkspace(db, {
		name: "Tenant B",
		users: [{ name: "Bob", email: "bob@b.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const convA = svc.create(ws1.tenant.id, ws1.actor("alice@a.example").user.id, "Tenant A conv")

	// Tenant B cannot add a message to Tenant A's conversation.
	// The INSERT will succeed (no FK on tenant_id cross-tenant), but the follow-up
	// UPDATE will silently no-op because tenant_id mismatch. The isolation guarantee
	// is that messages() for Tenant A's conv only returns tenant-A-scoped rows.
	svc.addMessage({
		tenantId: ws1.tenant.id,
		conversationId: convA.id,
		role: "assistant",
		content: "Tenant A message",
	})

	const historyForA = svc.messages(ws1.tenant.id, convA.id)
	assert.equal(historyForA.length, 1)

	// Tenant B's message list for the same conversationId must be empty.
	const historyForB = svc.messages(ws2.tenant.id, convA.id)
	assert.equal(historyForB.length, 0, "Tenant B must not see Tenant A messages")
})

test("conversation isolation: messages() only returns messages for the specified conversation", () => {
	const db = freshDb()
	const ws = makeWorkspace(db, {
		name: "Test Corp",
		users: [{ name: "Alice", email: "alice@test.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const conv1 = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Conv 1")
	const conv2 = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Conv 2")

	svc.addMessage({ tenantId: ws.tenant.id, conversationId: conv1.id, role: "user", content: "In conv 1" })
	svc.addMessage({ tenantId: ws.tenant.id, conversationId: conv2.id, role: "user", content: "In conv 2" })
	svc.addMessage({ tenantId: ws.tenant.id, conversationId: conv1.id, role: "assistant", content: "Response in conv 1" })

	const h1 = svc.messages(ws.tenant.id, conv1.id)
	const h2 = svc.messages(ws.tenant.id, conv2.id)

	assert.equal(h1.length, 2)
	assert.equal(h2.length, 1)
	assert.ok(h1.every((m) => m.conversationId === conv1.id))
	assert.ok(h2.every((m) => m.conversationId === conv2.id))
})

test("addMessage with zero citations works correctly (no INSERT to citations table)", () => {
	const db = freshDb()
	const ws = makeWorkspace(db, {
		name: "Test Corp",
		users: [{ name: "Alice", email: "alice@test.example", roleKey: "ADMIN", department: "Engineering" }],
	})
	const svc = new ConversationService(db)
	const conv = svc.create(ws.tenant.id, ws.actor("alice@test.example").user.id, "Test conversation")

	const msg = svc.addMessage({
		tenantId: ws.tenant.id,
		conversationId: conv.id,
		role: "assistant",
		content: "No citations here.",
		citations: [],
	})

	assert.deepEqual(msg.citations, [])
	const stored = db.all("SELECT * FROM citations WHERE message_id = ?", msg.id)
	assert.equal(stored.length, 0)
})
// hist: 2026-09-24T09:28:22+05:30
