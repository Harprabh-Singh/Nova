/**
 * Seeds the demo workspaces. Safe to re-run: tenants, roles, users and
 * documents are upserted, and re-ingesting an unchanged file is a no-op.
 *
 * Nothing here is referenced by business logic - it is data only.
 */
import fs from "node:fs"
import path from "node:path"

import { getConfig, loadEnv } from "../src/config/index.ts"
import { getDb } from "../src/db/index.ts"
import { createEmbeddingProvider } from "../src/embeddings/index.ts"
import { createVectorStore } from "../src/knowledge/index.ts"
import { DocumentService } from "../src/documents/service.ts"
import { ConversationService } from "../src/conversations/service.ts"
import {
	createTenant,
	grantPermission,
	upsertRole,
	upsertUser,
} from "../src/tenants/service.ts"
import type { Classification } from "../src/models/types.ts"

loadEnv()

type SeedDoc = {
	file: string
	department: string
	category: string
	classification?: Classification
	allowedRoles?: string[]
	title?: string
}

type SeedTenant = {
	slug: string
	name: string
	industry: string
	departments: string[]
	knowledgeDir: string
	roles: Array<{
		key: string
		name: string
		description?: string
		isAdmin?: boolean
		canUploadKnowledge?: boolean
		grants: Array<[string, Classification]>
	}>
	users: Array<{ name: string; email: string; roleKey: string; department: string; title: string }>
	documents: SeedDoc[]
}

const NOVATECH: SeedTenant = {
	slug: "novatech",
	name: "NovaTech Manufacturing",
	industry: "Manufacturing",
	departments: [
		"Human Resources",
		"Engineering",
		"Manufacturing Operations",
		"Finance",
		"Procurement",
		"Quality",
		"Safety",
		"IT & Security",
		"Management",
	],
	knowledgeDir: "novatech",
	roles: [
		{
			key: "ADMIN",
			name: "Enterprise Administrator",
			description: "Full administrative access to knowledge, users and settings.",
			isAdmin: true,
			canUploadKnowledge: true,
			grants: [["*", "restricted"]],
		},
		{ key: "EMPLOYEE", name: "Employee", description: "Standard employee access.", grants: [["*", "internal"]] },
		{ key: "MANAGER", name: "Manager", description: "People manager.", grants: [["*", "internal"]] },
		{
			key: "HR_MANAGER",
			name: "HR Manager",
			canUploadKnowledge: true,
			grants: [
				["*", "internal"],
				["Human Resources", "confidential"],
			],
		},
		{
			key: "FINANCE_MANAGER",
			name: "Finance Manager",
			grants: [
				["*", "internal"],
				["Finance", "confidential"],
				["Procurement", "confidential"],
			],
		},
		{
			key: "ENGINEERING_MANAGER",
			name: "Engineering Manager",
			grants: [
				["*", "internal"],
				["Engineering", "confidential"],
			],
		},
		{
			key: "SAFETY_MANAGER",
			name: "Safety Manager",
			grants: [
				["*", "internal"],
				["Safety", "confidential"],
				["Manufacturing Operations", "confidential"],
			],
		},
	],
	users: [
		{
			name: "Alex Mendes",
			email: "alex@novatech.example",
			roleKey: "EMPLOYEE",
			department: "Manufacturing Operations",
			title: "Production Employee",
		},
		{
			name: "Sarah Iyer",
			email: "sarah@novatech.example",
			roleKey: "ENGINEERING_MANAGER",
			department: "Engineering",
			title: "Engineering Manager",
		},
		{
			name: "David Rao",
			email: "david@novatech.example",
			roleKey: "FINANCE_MANAGER",
			department: "Finance",
			title: "Finance Manager",
		},
		{
			name: "Priya Nair",
			email: "priya@novatech.example",
			roleKey: "HR_MANAGER",
			department: "Human Resources",
			title: "HR Manager",
		},
		{
			name: "Admin User",
			email: "admin@novatech.example",
			roleKey: "ADMIN",
			department: "Management",
			title: "Enterprise Administrator",
		},
	],
	documents: [
		{ file: "hr/employee_handbook.md", department: "Human Resources", category: "handbook" },
		{ file: "hr/leave_policy.md", department: "Human Resources", category: "policy" },
		{ file: "hr/onboarding_policy.md", department: "Human Resources", category: "policy" },
		{ file: "hr/benefits_policy.md", department: "Human Resources", category: "policy" },
		{
			file: "hr-confidential/engineering_salary_structure.md",
			department: "Human Resources",
			category: "compensation",
			classification: "confidential",
			allowedRoles: ["HR_MANAGER", "ADMIN"],
		},
		{ file: "finance/expense_policy.md", department: "Finance", category: "policy" },
		{ file: "finance/procurement_policy.md", department: "Procurement", category: "policy" },
		{ file: "finance/approval_matrix.md", department: "Finance", category: "matrix" },
		{ file: "engineering/engineering_standards.md", department: "Engineering", category: "standard" },
		{ file: "engineering/deployment_sop.md", department: "Engineering", category: "sop" },
		{ file: "engineering/change_management.md", department: "Engineering", category: "policy" },
		{ file: "manufacturing/machine_operation_sop.md", department: "Manufacturing Operations", category: "sop" },
		{ file: "manufacturing/machine_failure_sop.md", department: "Manufacturing Operations", category: "sop" },
		{ file: "manufacturing/preventive_maintenance.md", department: "Manufacturing Operations", category: "plan" },
		{ file: "manufacturing/production_escalation.md", department: "Manufacturing Operations", category: "procedure" },
		{ file: "safety/workplace_safety.md", department: "Safety", category: "policy" },
		{ file: "safety/emergency_response.md", department: "Safety", category: "plan" },
		{ file: "safety/incident_reporting.md", department: "Safety", category: "procedure" },
		{ file: "quality/quality_control.md", department: "Quality", category: "procedure" },
		{ file: "quality/non_conformance.md", department: "Quality", category: "procedure" },
		{ file: "security/information_security.md", department: "IT & Security", category: "policy" },
		{ file: "security/security_incident_response.md", department: "IT & Security", category: "plan" },
		{ file: "security/access_control.md", department: "IT & Security", category: "policy" },
		{ file: "security/vendor_integration_notice.md", department: "IT & Security", category: "notice" },
		{ file: "management/company_policies.md", department: "Management", category: "policy" },
		{
			file: "management/strategic_guidelines.md",
			department: "Management",
			category: "guideline",
			classification: "confidential",
		},
	],
}

/** Second tenant proves the platform is not built around one company. */
const ACME: SeedTenant = {
	slug: "acme-logistics",
	name: "Acme Logistics",
	industry: "Logistics",
	departments: ["Operations", "Human Resources", "Finance", "Customer Service"],
	knowledgeDir: "acme-logistics",
	roles: [
		{ key: "ADMIN", name: "Enterprise Administrator", isAdmin: true, canUploadKnowledge: true, grants: [["*", "restricted"]] },
		{ key: "EMPLOYEE", name: "Employee", grants: [["*", "internal"]] },
	],
	users: [
		{ name: "Meera Shah", email: "meera@acme.example", roleKey: "EMPLOYEE", department: "Operations", title: "Dispatch Coordinator" },
		{ name: "Acme Admin", email: "admin@acme.example", roleKey: "ADMIN", department: "Operations", title: "Administrator" },
	],
	documents: [
		{ file: "operations/fleet_operations_policy.md", department: "Operations", category: "policy" },
		{ file: "hr/leave_policy.md", department: "Human Resources", category: "policy" },
	],
}

async function seedTenant(spec: SeedTenant, documents: DocumentService) {
	const db = getDb()
	const config = getConfig()
	const tenant = createTenant(db, {
		name: spec.name,
		slug: spec.slug,
		industry: spec.industry,
		settings: { departments: spec.departments },
	})

	for (const role of spec.roles) {
		upsertRole(db, {
			tenantId: tenant.id,
			key: role.key,
			name: role.name,
			description: role.description ?? "",
			isAdmin: role.isAdmin,
			canUploadKnowledge: role.canUploadKnowledge,
		})
		for (const [department, maxClassification] of role.grants) {
			grantPermission(db, { tenantId: tenant.id, roleKey: role.key, department, maxClassification })
		}
	}

	const users = spec.users.map((u) => upsertUser(db, { tenantId: tenant.id, ...u }))

	const root = path.resolve(config.paths.seedKnowledgeDir, spec.knowledgeDir)
	let ingested = 0
	for (const doc of spec.documents) {
		const filePath = path.join(root, doc.file)
		if (!fs.existsSync(filePath)) {
			console.warn(`  ! missing seed file: ${filePath}`)
			continue
		}
		const result = await documents.ingest({
			tenantId: tenant.id,
			filename: path.basename(filePath),
			buffer: fs.readFileSync(filePath),
			uploadedBy: "seed-demo",
			title: doc.title,
			department: doc.department,
			category: doc.category,
			classification: doc.classification,
			allowedRoles: doc.allowedRoles ?? [],
		})
		ingested += 1
		if (result.injectionFlags.length) {
			console.log(`  \u26a0 injection patterns quarantined in ${doc.file}: ${result.injectionFlags.join(", ")}`)
		}
	}

	return { tenant, users, ingested }
}

async function main() {
	const db = getDb()
	const embeddings = createEmbeddingProvider()
	const vectorStore = createVectorStore(db)
	const documents = new DocumentService(db, embeddings, vectorStore)
	const conversations = new ConversationService(db)

	console.log("Seeding NOVA demo data...")
	const novatech = await seedTenant(NOVATECH, documents)
	console.log(`  ${novatech.tenant.name}: ${novatech.users.length} users, ${novatech.ingested} documents`)

	// Document versioning demo: Expense Policy 2026.1 (seeded above) superseded by 2026.2.
	const v2 = path.resolve(getConfig().paths.seedKnowledgeDir, "novatech/finance/expense_policy_2026.2.md")
	if (fs.existsSync(v2)) {
		const result = await documents.ingest({
			tenantId: novatech.tenant.id,
			filename: "expense_policy.md",
			buffer: fs.readFileSync(v2),
			uploadedBy: "seed-demo",
			department: "Finance",
			category: "policy",
			activate: true,
		})
		console.log(`  Expense Policy active version: ${result.version.version}`)
	}

	const acme = await seedTenant(ACME, documents)
	console.log(`  ${acme.tenant.name}: ${acme.users.length} users, ${acme.ingested} documents`)

	// One sample conversation so the history panel is not empty on first run.
	const alex = novatech.users.find((u) => u.email === "alex@novatech.example")
	if (alex && conversations.list(novatech.tenant.id, alex.id).length === 0) {
		const conversation = conversations.create(novatech.tenant.id, alex.id, "Machine failure procedure")
		conversations.addMessage({
			tenantId: novatech.tenant.id,
			conversationId: conversation.id,
			userId: alex.id,
			role: "user",
			content: "What is our machine failure procedure?",
		})
	}

	console.log("Knowledge base ready.")
	console.log("Demo personas: Alex (Employee), Sarah (Engineering Manager), David (Finance Manager), Priya (HR Manager), Admin.")
}

main().catch((error) => {
	console.error("seed-demo failed:", error instanceof Error ? error.message : error)
	process.exit(1)
})
