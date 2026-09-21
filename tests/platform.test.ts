/**
 * Platform suite: ingestion, versioning, retrieval quality, generic tenancy,
 * the agentic workflow and local-mode guarantees.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { freshDb, ingestText, makeWorkspace, services } from "./helpers.ts"
import { getConfig } from "../backend/src/config/index.ts"
import { detectMetadata } from "../backend/src/documents/service.ts"

const HANDBOOK = `Field Operations Handbook
Department: Operations
Category: handbook
Classification: internal
Version: 1.0
Effective date: 2026-01-01

## Dispatch windows
Standard dispatch windows are 06:00 to 14:00 and 14:00 to 22:00.
A third window may be opened with depot manager approval.

## Vehicle checks
Drivers complete a pre-trip inspection covering brakes, tyres, lights and load restraint.
Any defect classified as major removes the vehicle from service until repaired.
`

test("local mode is the default and no Azure settings are materialised", () => {
	const config = getConfig()
	assert.equal(config.appMode, "local")
	assert.equal(config.isFullyLocal, true)
	assert.equal(config.modes.aiMode, "local")
	assert.equal(config.modes.knowledgeMode, "local")
	assert.equal(config.modes.authMode, "demo")
	assert.equal(config.azure, null)
})

test("metadata is detected from document front matter", () => {
	const metadata = detectMetadata(HANDBOOK, "vehicle_policy.md")
	assert.equal(metadata.department, "Operations")
	assert.equal(metadata.classification, "internal")
	assert.equal(metadata.version, "1.0")
	assert.equal(metadata.effectiveDate, "2026-01-01")
	assert.equal(metadata.title, "Field Operations Handbook")
})

test("ingestion chunks, embeds, indexes and makes a document searchable", async () => {
	const db = freshDb()
	const svc = services(db)
	const ws = makeWorkspace(db, {
		name: "Acme Logistics",
		industry: "Logistics",
		departments: ["Operations", "Finance"],
		users: [{ name: "Meera Shah", email: "meera@acme.example", roleKey: "ADMIN", department: "Operations" }],
	})
	const admin = ws.actor("meera@acme.example")

	const before = await svc.knowledgeAgent.answer({
		tenant: ws.tenant,
		user: admin.user,
		scope: admin.scope,
		question: "What are our standard dispatch windows?",
		requestId: "p1a",
	})
	assert.notEqual(before.grounding, "grounded", "nothing should be answerable before ingestion")

	const ingest = await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "field_operations_handbook.md",
		text: HANDBOOK,
		uploadedBy: admin.user.id,
	})
	assert.ok(ingest.chunkCount > 0)
	assert.equal(ingest.version.ingestStatus, "indexed")

	const after = await svc.knowledgeAgent.answer({
		tenant: ws.tenant,
		user: admin.user,
		scope: admin.scope,
		question: "What are our standard dispatch windows?",
		requestId: "p1b",
	})
	assert.ok(after.citations.length > 0, "the uploaded document must be retrievable without code changes")
	assert.match(after.answer, /06:00|14:00/)
})

test("re-ingesting the same file is idempotent", async () => {
	const db = freshDb()
	const svc = services(db)
	const ws = makeWorkspace(db, {
		name: "Acme Logistics",
		users: [{ name: "Meera Shah", email: "meera@acme.example", roleKey: "ADMIN", department: "Operations" }],
	})
	const admin = ws.actor("meera@acme.example")
	const first = await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "field_operations_handbook.md",
		text: HANDBOOK,
		uploadedBy: admin.user.id,
	})
	const second = await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "field_operations_handbook.md",
		text: HANDBOOK,
		uploadedBy: admin.user.id,
	})
	assert.equal(second.version.id, first.version.id)
	assert.equal(svc.documents.listVersions(ws.tenant.id, first.document.id).length, 1)
})

test("version history is preserved and administrators can roll back", async () => {
	const db = freshDb()
	const svc = services(db)
	const ws = makeWorkspace(db, {
		name: "Acme Logistics",
		users: [{ name: "Meera Shah", email: "meera@acme.example", roleKey: "ADMIN", department: "Operations" }],
	})
	const admin = ws.actor("meera@acme.example")
	const v1 = await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "expense_policy.md",
		text: "Expense Policy\nDepartment: Finance\nVersion: 2026.1\n\nClaims are submitted within 45 days.",
		uploadedBy: admin.user.id,
		version: "2026.1",
	})
	const v2 = await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "expense_policy.md",
		text: "Expense Policy\nDepartment: Finance\nVersion: 2026.2\n\nClaims are submitted within 21 days.",
		uploadedBy: admin.user.id,
		version: "2026.2",
		activate: true,
	})
	assert.equal(v1.document.id, v2.document.id)
	const versions = svc.documents.listVersions(ws.tenant.id, v2.document.id)
	assert.equal(versions.length, 2, "history must be preserved")
	assert.equal(svc.documents.activeVersion(ws.tenant.id, v2.document.id)?.version, "2026.2")

	await svc.documents.activateVersion(ws.tenant.id, v2.document.id, v1.version.id)
	assert.equal(svc.documents.activeVersion(ws.tenant.id, v2.document.id)?.version, "2026.1")
})

test("deleting a document removes it from the retrieval index", async () => {
	const db = freshDb()
	const svc = services(db)
	const ws = makeWorkspace(db, {
		name: "Acme Logistics",
		users: [{ name: "Meera Shah", email: "meera@acme.example", roleKey: "ADMIN", department: "Operations" }],
	})
	const admin = ws.actor("meera@acme.example")
	const ingest = await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "field_operations_handbook.md",
		text: HANDBOOK,
		uploadedBy: admin.user.id,
	})
	await svc.documents.deleteDocument(ws.tenant.id, ingest.document.id)
	const chunks = db.all(`SELECT id FROM document_chunks WHERE document_id = ?`, ingest.document.id)
	assert.equal(chunks.length, 0)
	assert.equal(svc.documents.getDocument(ws.tenant.id, ingest.document.id), null)
})

test("multi-document reasoning cites more than one source", async () => {
	const db = freshDb()
	const svc = services(db)
	const ws = makeWorkspace(db, {
		name: "Acme Logistics",
		departments: ["Finance", "Operations"],
		users: [{ name: "Meera Shah", email: "meera@acme.example", roleKey: "ADMIN", department: "Finance" }],
	})
	const admin = ws.actor("meera@acme.example")
	await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "procurement_policy.md",
		text: "Procurement Policy\nDepartment: Finance\n\nPurchases between 25,001 and 100,000 require department head approval and two written quotations.",
		uploadedBy: admin.user.id,
		department: "Finance",
	})
	await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "approval_matrix.md",
		text: "Approval Matrix\nDepartment: Finance\n\nCapital purchases up to 100,000 are approved by the department head. Above that the finance manager approves.",
		uploadedBy: admin.user.id,
		department: "Finance",
	})
	const result = await svc.knowledgeAgent.answer({
		tenant: ws.tenant,
		user: admin.user,
		scope: admin.scope,
		question: "Can I approve an 80,000 equipment purchase?",
		requestId: "p2",
	})
	const titles = new Set(result.citations.map((c) => c.documentTitle))
	assert.ok(titles.size >= 2, "the answer should combine both finance documents")
})

test("the incident workflow collects fields and creates a simulated incident", async () => {
	const db = freshDb()
	const svc = services(db)
	const ws = makeWorkspace(db, {
		name: "Acme Logistics",
		departments: ["Operations"],
		users: [{ name: "Meera Shah", email: "meera@acme.example", roleKey: "ADMIN", department: "Operations" }],
	})
	const admin = ws.actor("meera@acme.example")
	await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "incident_reporting.md",
		text: "Incident Reporting\nDepartment: Operations\n\nReport asset failures within 15 minutes with machine id, description, severity, location and time.",
		uploadedBy: admin.user.id,
		department: "Operations",
	})

	const first = await svc.incidentAgent.handle({
		tenant: ws.tenant,
		user: admin.user,
		scope: admin.scope,
		message: "Machine M-204 has malfunctioned. Help me report it.",
		draft: {},
		conversationId: "conv_1",
	})
	assert.equal(first.draft.machine_id, "M-204")
	assert.ok(first.missing.length > 0, "the agent should ask for the missing fields")
	assert.equal(first.action, null)

	const second = await svc.incidentAgent.handle({
		tenant: ws.tenant,
		user: admin.user,
		scope: admin.scope,
		message:
			"severity: high, location: line 4, observed_at: 2026-09-14 09:15, description: hydraulic pressure loss during the morning run",
		draft: first.draft,
		conversationId: "conv_1",
	})
	assert.ok(second.action, "the workflow should complete once all fields are present")
	assert.equal(second.action?.simulated, true)
	assert.match(second.action!.incident.code, /^INC-\d{4}-\d{4}$/)
	assert.equal(second.action!.incident.tenantId, ws.tenant.id)
})

test("activity is audited without leaking document contents", async () => {
	const db = freshDb()
	const svc = services(db)
	const ws = makeWorkspace(db, {
		name: "Acme Logistics",
		users: [{ name: "Meera Shah", email: "meera@acme.example", roleKey: "ADMIN", department: "Operations" }],
	})
	const admin = ws.actor("meera@acme.example")
	await ingestText(svc, {
		tenantId: ws.tenant.id,
		filename: "field_operations_handbook.md",
		text: HANDBOOK,
		uploadedBy: admin.user.id,
	})
	const logs = db.all(`SELECT * FROM activity_logs WHERE tenant_id = ?`, ws.tenant.id)
	assert.ok(logs.length > 0)
	for (const entry of logs) {
		assert.ok(!String(entry.detail ?? "").includes("pre-trip inspection"), "document bodies must never be logged")
	}
})
// hist: 2026-09-21T22:01:37+05:30
