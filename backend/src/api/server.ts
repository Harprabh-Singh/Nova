/**
 * NOVA HTTP API.
 *
 * Architectural rules enforced here:
 *  - Identity comes from the AuthProvider, never from the client body.
 *  - Every handler resolves a tenant-scoped AccessScope before touching data.
 *  - Errors are mapped to safe messages; stack traces are never returned.
 */
import http from "node:http"
import https from "node:https"
import fs from "node:fs"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

import { getConfig } from "../config/index.ts"
import { buildHealthPayload, computeAzureReadiness, azureConfigSnapshot } from "./health.ts"
import { getDb, type Database } from "../db/index.ts"
import { log, newRequestId, recordActivity, listActivity } from "../observability/logger.ts"
import { createAuthProvider, AuthError, type AuthProvider } from "../auth/index.ts"
import { buildAccessScope, decideDocumentAccess } from "../authorization/policy.ts"
import { createEmbeddingProvider } from "../embeddings/index.ts"
import { createLLMProvider } from "../llm/index.ts"
import { createKnowledgeProvider, createVectorStore } from "../knowledge/index.ts"
import { createActionProvider } from "../actions/index.ts"
import { createGovernedActionService, GovernedActionError, type GovernedActionService } from "../actions/governed/index.ts"
import { ACTION_PERMISSIONS } from "../actions/governed/registry.ts"
import { DocumentService, DocumentError, safeDownloadName } from "../documents/service.ts"
import { createStorageProvider } from "../storage/index.ts"
import { StorageError, type StorageProvider } from "../storage/base.ts"
import { ConversationService } from "../conversations/service.ts"
import { KnowledgeAgent } from "../agents/knowledgeAgent.ts"
import { IncidentAgent, type IncidentDraft } from "../agents/incidentAgent.ts"
import { understandQuery } from "../agents/queryUnderstanding.ts"
import { detectSmalltalk, smalltalkReply } from "../agents/smalltalk.ts"
import { GeneralAgent, classifyUnanswered } from "../agents/general.ts"
import {
	createTenant,
	getTenant,
	grantPermission,
	listPermissions,
	listRoles,
	listTenants,
	listUsers,
	updateTenantSettings,
	upsertRole,
	upsertUser,
	getUser,
	linkEntraIdentity,
	unlinkEntraIdentity,
	setUserStatus,
	IdentityLinkError,
} from "../tenants/service.ts"
import {
	grantActionPermission,
	listActionPermissionGrants,
	revokeActionPermission,
} from "../tenants/service.ts"
import type { Classification, Principal, Tenant, User } from "../models/types.ts"
import { CLASSIFICATIONS } from "../models/types.ts"
import { HttpError, Router, parseMultipart, readBody, readJson, sendJson, type Ctx } from "./http.ts"
import { applySecurityHeaders, assertSameOrigin, enforceRateLimit } from "./security.ts"
import { resolveTlsMaterial } from "./tls.ts"

export type Services = {
	db: Database
	auth: AuthProvider
	storage: StorageProvider
	documents: DocumentService
	conversations: ConversationService
	knowledgeAgent: KnowledgeAgent
	generalAgent: GeneralAgent
	incidentAgent: IncidentAgent
	/** Phase 8: registry-driven governed enterprise actions. */
	actions: GovernedActionService
	providers: {
		llm: ReturnType<typeof createLLMProvider>
		embeddings: ReturnType<typeof createEmbeddingProvider>
		knowledge: ReturnType<typeof createKnowledgeProvider>
		vectorStore: ReturnType<typeof createVectorStore>
		actions: ReturnType<typeof createActionProvider>
		storage: StorageProvider
	}
}

export function createServices(db: Database = getDb()): Services {
	const embeddings = createEmbeddingProvider()
	const vectorStore = createVectorStore(db)
	const knowledge = createKnowledgeProvider(vectorStore, embeddings)
	const llm = createLLMProvider()
	const actions = createActionProvider(db)
	// Constructed once: local filesystem in local/demo mode, Azure Blob Storage
	// in production/Azure mode. Construction fails loudly when Azure storage is
	// selected without complete configuration - there is no local fallback.
	const storage = createStorageProvider()
	const documents = new DocumentService(db, embeddings, vectorStore, storage)
	const conversations = new ConversationService(db)
	return {
		db,
		auth: createAuthProvider(db),
		storage,
		documents,
		conversations,
		knowledgeAgent: new KnowledgeAgent(db, knowledge, llm),
		generalAgent: new GeneralAgent(llm),
		incidentAgent: new IncidentAgent(db, knowledge, actions),
		/**
		 * Phase 8. The executor is chosen by ACTION_MODE here, once, at startup:
		 * local mock or the NOVA Actions Azure Function app. Construction throws
		 * when ACTION_MODE=azure is set without an endpoint, so a deployment can
		 * never silently simulate a write it claimed to make.
		 */
		actions: createGovernedActionService(db),
		providers: { llm, embeddings, knowledge, vectorStore, actions, storage },
	}
}

/* ------------------------------- helpers -------------------------------- */

async function requirePrincipal(services: Services, req: IncomingMessage): Promise<Principal> {
	const header = req.headers["authorization"]
	const token = typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7) : ""
	if (!token) throw new HttpError(401, "Sign in to continue.", "unauthenticated")
	const principal = await services.auth.verify(token)
	if (!principal) throw new HttpError(401, "Your session has expired. Please sign in again.", "unauthenticated")
	return principal
}

/** The bearer token on the request, or "" when none was supplied. */
function bearerToken(req: IncomingMessage): string {
	const header = req.headers["authorization"]
	return typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""
}

type Identity = { principal: Principal; tenant: Tenant; user: User; scope: ReturnType<typeof buildAccessScope> }

async function requireIdentity(services: Services, req: IncomingMessage): Promise<Identity> {
	const principal = await requirePrincipal(services, req)
	const tenant = getTenant(services.db, principal.tenantId)
	if (!tenant) throw new HttpError(404, "Workspace not found.", "tenant_not_found")
	const user = getUser(services.db, tenant.id, principal.userId)
	if (!user) throw new HttpError(401, "User no longer exists.", "unauthenticated")
	// A pending (auto-provisioned) or disabled NOVA user is authenticated but
	// not authorized: 403, never a silent downgrade to a demo identity.
	if (user.status !== "active") {
		throw new HttpError(403, "Your NOVA access is awaiting administrator approval.", "identity_pending")
	}
	return { principal, tenant, user, scope: buildAccessScope(services.db, principal) }
}

function requireAdmin(identity: Identity): void {
	if (!identity.scope.isAdmin) throw new HttpError(403, "Administrator access is required.", "forbidden")
}

/* ---- input validation -------------------------------------------------
 * The frontend is not a trust boundary. Every identifier, page size and free
 * text field that reaches a handler is validated here first, so a malformed
 * or hostile request is rejected before it can touch the database.
 */

const ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/

function requireId(value: unknown, field: string): string {
	const id = String(value ?? "")
	if (!ID_PATTERN.test(id)) throw new HttpError(400, `A valid ${field} is required.`, "malformed_request")
	return id
}

function optionalId(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined
	return requireId(value, field)
}

function requireText(value: unknown, field: string, max: number): string {
	const text = String(value ?? "").trim()
	if (!text) throw new HttpError(400, `${field} is required.`, "malformed_request")
	if (text.length > max) throw new HttpError(400, `${field} is too long.`, "malformed_request")
	return text
}

function boundedLimit(raw: string | null, fallback: number, max: number): number {
	const value = Number(raw ?? fallback)
	if (!Number.isFinite(value) || value <= 0) return fallback
	return Math.min(Math.floor(value), max)
}

/**
 * Conversations are per-user, not per-tenant. Sharing a workspace with someone
 * is not permission to read, extend, delete or re-title their transcript, so
 * every conversation-scoped route resolves through this and gets an
 * indistinguishable 404 when ownership fails (no existence oracle).
 */
function requireOwnedConversation(services: Services, identity: Identity, conversationId: string) {
	const conversation = services.conversations.getOwned(identity.tenant.id, identity.user.id, conversationId)
	if (!conversation) throw new HttpError(404, "Conversation not found.", "not_found")
	return conversation
}

function asClassification(value: unknown, fallback: Classification = "internal"): Classification {
	const candidate = String(value ?? "").toLowerCase() as Classification
	return CLASSIFICATIONS.includes(candidate) ? candidate : fallback
}

/**
 * Statistics computed only from the documents the caller may actually see.
 * Counting restricted material - even without naming it - tells an
 * unauthorised reader that it exists, so non-admin figures are derived from
 * the already-filtered list rather than from tenant-wide SQL.
 */
function scopedDocumentStats(
	documents: Array<{ status: string; department: string; versions?: Array<{ chunkCount?: number }> }>,
) {
	const active = documents.filter((doc) => doc.status === "active")
	const byDepartment = new Map<string, number>()
	for (const doc of active) byDepartment.set(doc.department, (byDepartment.get(doc.department) ?? 0) + 1)
	return {
		documents: active.length,
		chunks: documents.reduce(
			(total, doc) => total + (doc.versions ?? []).reduce((sum, v) => sum + (v.chunkCount ?? 0), 0),
			0,
		),
		versions: documents.reduce((total, doc) => total + (doc.versions?.length ?? 0), 0),
		failedIngestions: 0,
		byDepartment: [...byDepartment.entries()]
			.map(([department, count]) => ({ department, count }))
			.sort((a, b) => b.count - a.count),
	}
}

function toList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
	if (typeof value === "string" && value.trim()) {
		return value
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean)
	}
	return []
}

/* -------------------------------- routes -------------------------------- */

export function buildRouter(services: Services): Router {
	const router = new Router()
	const { db } = services

	/* ---- modes + health -------------------------------------------------
	 * LOCAL ONLY. This route performs no chat, embedding, Search or any other
	 * remote request, so polling it costs zero model tokens. It reports
	 * whether the process is alive, the configuration is complete, and the
	 * expected provider implementations are loaded. Live Azure connectivity is
	 * proven by real application requests, not by this endpoint.
	 */

	router.get("/api/health", ({ res }) => {
		const payload = buildHealthPayload(getConfig(), {
			llm: services.providers.llm,
			embeddings: services.providers.embeddings,
			knowledge: services.providers.knowledge,
			vectorStore: services.providers.vectorStore,
			auth: services.auth,
			actions: services.providers.actions,
			// Identity only. buildHealthPayload never calls a provider, so this
			// route still makes zero remote requests - including zero to Blob Storage.
			storage: services.providers.storage,
		})
		sendJson(res, 200, payload)
	})

	/* ---- tenants, personas, session ------------------------------------ */

	router.get("/api/tenants", async ({ res }) => {
		sendJson(res, 200, {
			tenants: listTenants(db).map((tenant) => ({
				id: tenant.id,
				slug: tenant.slug,
				name: tenant.name,
				industry: tenant.industry,
				departments: tenant.settings.departments,
			})),
		})
	})

	/** Persona list for the demo selector. Only available with demo auth. */
	router.get("/api/personas", async ({ res, url }) => {
		if (services.auth.mode !== "demo") {
			throw new HttpError(404, "Persona switching is only available in demo authentication mode.", "not_found")
		}
		const tenants = listTenants(db)
		const requested = url.searchParams.get("tenantId")
		const tenant = (requested ? tenants.find((t) => t.id === requested) : tenants[0]) ?? tenants[0]
		if (!tenant) return sendJson(res, 200, { tenant: null, personas: [], notice: "DEMO PERSONA" })
		const roles = listRoles(db, tenant.id)
		sendJson(res, 200, {
			notice: "DEMO PERSONA - local demo authentication, not a real identity provider.",
			tenant: { id: tenant.id, name: tenant.name, industry: tenant.industry },
			personas: listUsers(db, tenant.id).map((user) => ({
				id: user.id,
				name: user.name,
				email: user.email,
				department: user.department,
				title: user.title,
				roleKey: user.roleKey,
				roleName: roles.find((r) => r.key === user.roleKey)?.name ?? user.roleKey,
				isAdmin: roles.find((r) => r.key === user.roleKey)?.isAdmin ?? false,
			})),
		})
	})

	router.post("/api/session", async ({ req, res, requestId }) => {
		// Unauthenticated + state-changing: rate limited and origin-checked.
		enforceRateLimit(req, res, "auth")
		assertSameOrigin(req)
		const body = await readJson<{ tenantId?: string; userId?: string; email?: string; bearerToken?: string }>(req)
		/**
		 * Entra mode. The client proves who it is with a validated Microsoft
		 * access token and nothing else: tenantId, userId and email in the body
		 * are ignored, so a caller cannot ask to become another tenant's user.
		 */
		if (services.auth.mode === "entra") {
			const token = bearerToken(req) || String(body.bearerToken ?? "")
			const session = await services.auth.createSession({ tenantId: "", bearerToken: token })
			recordActivity(db, {
				tenantId: session.principal.tenantId,
				userId: session.principal.userId,
				userName: session.principal.name,
				action: "Session Started",
				resourceType: "session",
				status: "success",
				detail: "auth mode: entra",
				requestId,
			})
			// The token is the client's own; it is never re-issued or logged.
			return sendJson(res, 200, {
				token: "",
				principal: session.principal,
				expiresAt: session.expiresAt,
				notice: session.notice,
			})
		}
		const tenantId = optionalId(body.tenantId, "tenantId") || listTenants(db)[0]?.id
		if (!tenantId) throw new HttpError(400, "No workspace has been created yet. Run the seed command first.", "no_tenant")
		const session = await services.auth.createSession({
			tenantId,
			userId: optionalId(body.userId, "userId"),
			email: body.email ? String(body.email).slice(0, 320) : undefined,
			bearerToken: body.bearerToken,
		})
		recordActivity(db, {
			tenantId,
			userId: session.principal.userId,
			userName: session.principal.name,
			action: "Session Started",
			resourceType: "session",
			status: "success",
			detail: `auth mode: ${services.auth.mode}`,
			requestId,
		})
		sendJson(res, 200, session)
	})

	/* ---- authentication ------------------------------------------------
	 * PUBLIC, zero-token, no remote call. The SPA needs the public Entra
	 * application settings (client id, authority, scope, redirect URI) to run
	 * MSAL. They are configuration, not secrets, and nothing secret is ever
	 * added here.
	 */
	router.get("/api/auth/config", async ({ res }) => {
		const config = getConfig()
		const entraMode = config.modes.authMode === "entra"
		sendJson(res, 200, {
			authMode: config.modes.authMode,
			isProduction: services.auth.isProduction,
			provider: services.auth.name,
			entra: entraMode
				? {
					clientId: config.entra.clientId,
					tenantId: config.entra.tenantId,
					authority: config.entra.authority,
					apiScope: config.entra.apiScope,
					redirectUri: config.entra.redirectUri,
					postLogoutRedirectUri: config.entra.postLogoutRedirectUri,
				}
				: null,
		})
	})

	/**
	 * The authenticated NOVA identity. Safe fields only: no access token, no
	 * refresh token, no authorization header, no Entra credentials and no raw
	 * token claims.
	 */
	router.get("/api/auth/me", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		const role = listRoles(db, identity.tenant.id).find((r) => r.key === identity.user.roleKey)
		sendJson(res, 200, {
			authMode: services.auth.mode,
			user: {
				id: identity.user.id,
				name: identity.user.name,
				email: identity.user.email,
				department: identity.user.department,
				title: identity.user.title,
				roleKey: identity.user.roleKey,
				status: identity.user.status,
				// Presence only: the linked identity is never echoed back.
				entraLinked: Boolean(identity.user.entraObjectId),
			},
			tenant: { id: identity.tenant.id, name: identity.tenant.name, slug: identity.tenant.slug },
			role: role ? { key: role.key, name: role.name, isAdmin: role.isAdmin } : null,
			// Effective clearance, resolved server-side from Neon.
			scope: {
				isAdmin: identity.scope.isAdmin,
				canUploadKnowledge: identity.scope.canUploadKnowledge,
				canCreateIncidents: identity.scope.canCreateIncidents,
				grants: identity.scope.grants,
				maxLevelAnywhere: identity.scope.maxLevelAnywhere,
			},
		})
	})

	router.get("/api/me", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		const role = listRoles(db, identity.tenant.id).find((r) => r.key === identity.user.roleKey)
		sendJson(res, 200, {
			user: identity.user,
			role,
			tenant: identity.tenant,
			permissions: listPermissions(db, identity.tenant.id, identity.user.roleKey),
			scope: {
				isAdmin: identity.scope.isAdmin,
				canUploadKnowledge: identity.scope.canUploadKnowledge,
				canCreateIncidents: identity.scope.canCreateIncidents,
				grants: identity.scope.grants,
			},
			auth: { mode: services.auth.mode, isProduction: services.auth.isProduction },
		})
	})

	/* ---- conversations + chat ------------------------------------------ */

	router.get("/api/conversations", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		sendJson(res, 200, { conversations: services.conversations.list(identity.tenant.id, identity.user.id) })
	})

	router.post("/api/conversations", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		const body = await readJson<{ title?: string }>(req)
		sendJson(res, 201, {
			conversation: services.conversations.create(identity.tenant.id, identity.user.id, body.title || "New conversation"),
		})
	})

	router.get("/api/conversations/:id", async ({ req, res, params }) => {
		const identity = await requireIdentity(services, req)
		const conversation = requireOwnedConversation(services, identity, requireId(params.id, "conversation id"))
		sendJson(res, 200, {
			conversation,
			messages: services.conversations.messages(identity.tenant.id, conversation.id),
		})
	})

	router.delete("/api/conversations/:id", async ({ req, res, params, requestId }) => {
		const identity = await requireIdentity(services, req)
		// Same tenant is NOT enough to delete someone else's transcript.
		const conversation = requireOwnedConversation(services, identity, requireId(params.id, "conversation id"))
		services.conversations.delete(identity.tenant.id, conversation.id)
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: "Conversation Deleted",
			resourceType: "conversation",
			resourceId: conversation.id,
			status: "success",
			requestId,
		})
		sendJson(res, 200, { ok: true })
	})

	router.post("/api/chat", async ({ req, res, requestId }) => {
		const identity = await requireIdentity(services, req)
		enforceRateLimit(req, res, "chat")
		const body = await readJson<{ message?: string; conversationId?: string }>(req)
		const message = requireText(body.message, "A message", 4000)
		const requestedConversationId = optionalId(body.conversationId, "conversationId")

		const started = Date.now()
		const { tenant, user, scope } = identity
		// A conversationId from the client proves nothing. Appending to a thread
		// requires ownership; otherwise the turn starts a new conversation would
		// silently write into someone else's history.
		const conversation = requestedConversationId
			? requireOwnedConversation(services, identity, requestedConversationId)
			: services.conversations.create(tenant.id, user.id, message.slice(0, 80))

		services.conversations.addMessage({
			tenantId: tenant.id,
			conversationId: conversation.id,
			userId: user.id,
			role: "user",
			content: message,
		})

		const state = services.conversations.getState<{ incidentDraft?: IncidentDraft; awaitingIncident?: boolean }>(
			tenant.id,
			conversation.id,
		)
		const understanding = understandQuery(db, tenant.id, message)

		// Conversational turns (hi, thanks, who are you, …) are answered directly
		// by the smalltalk engine — retrieval never sees them, so the assistant
		// behaves like a real chatbot instead of a search box.
		const smalltalkIntent = detectSmalltalk(message, tenant.settings.assistantName)
		if (smalltalkIntent && state.awaitingIncident !== true) {
			const reply = smalltalkReply(db, tenant, user, smalltalkIntent)
			const assistant = services.conversations.addMessage({
				tenantId: tenant.id,
				conversationId: conversation.id,
				userId: user.id,
				role: "assistant",
				content: reply,
				provider: "smalltalk",
				latencyMs: Date.now() - started,
				citations: [],
			})
			recordActivity(db, {
				tenantId: tenant.id,
				userId: user.id,
				userName: user.name,
				action: "Smalltalk",
				resourceType: "conversation",
				resourceId: conversation.id,
				status: "success",
				detail: `intent=${smalltalkIntent}`,
				requestId,
				latencyMs: Date.now() - started,
			})
			return sendJson(res, 200, {
				conversationId: conversation.id,
				message: assistant,
				workflow: null,
				retrieval: null,
				security: null,
			})
		}

		const isIncidentTurn = understanding.intent === "action.incident" || state.awaitingIncident === true

		if (isIncidentTurn) {
			const result = await services.incidentAgent.handle({
				tenant,
				user,
				scope,
				message,
				draft: state.incidentDraft ?? {},
				conversationId: conversation.id,
			})
			services.conversations.setState(tenant.id, conversation.id, {
				incidentDraft: result.complete ? {} : result.draft,
				awaitingIncident: !result.complete && result.missing.length > 0,
			})
			const assistant = services.conversations.addMessage({
				tenantId: tenant.id,
				conversationId: conversation.id,
				userId: user.id,
				role: "assistant",
				content: result.answer,
				grounding: result.citations.length ? "grounded" : "insufficient_evidence",
				confidence: result.citations.length ? "medium" : "none",
				provider: services.providers.actions.name,
				latencyMs: Date.now() - started,
				citations: result.citations,
				action: result.action,
			})
			recordActivity(db, {
				tenantId: tenant.id,
				userId: user.id,
				userName: user.name,
				action: result.action ? "Incident Created" : "Incident Intake",
				resourceType: "incident",
				resourceId: result.action?.incident.code ?? null,
				status: result.answer.startsWith("ACCESS DENIED") ? "denied" : "success",
				detail: result.action ? `${result.action.incident.code} (simulated)` : `missing: ${result.missing.join(", ")}`,
				requestId,
				latencyMs: Date.now() - started,
			})
			return sendJson(res, 200, {
				conversationId: conversation.id,
				message: assistant,
				workflow: { kind: "incident", missing: result.missing, complete: result.complete },
				retrieval: null,
				security: { accessDenied: result.answer.startsWith("ACCESS DENIED") },
			})
		}

		const history = services.conversations
			.messages(tenant.id, conversation.id)
			.slice(-7, -1)
			.map((m) => ({ role: m.role, content: m.content }))

		const result = await services.knowledgeAgent.answer({
			tenant,
			user,
			scope,
			question: message,
			history,
			requestId,
		})

		// Nothing in the authorised corpus answered this. If the question was
		// general ("what is a kanban board", "convert this", "write me a note"),
		// answer it like a normal assistant would - no evidence, no grounding
		// claim. Company-specific misses keep the honest refusal. That is the
		// ChatGPT/Claude/Gemini contract: a scoped system prompt restricts the
		// company topics, it does not stop the assistant from being useful.
		if (result.outOfScope && classifyUnanswered(message) === "general") {
			const general = await services.generalAgent.answer({ tenant, user, question: message, history })
			const generalMessage = services.conversations.addMessage({
				tenantId: tenant.id,
				conversationId: conversation.id,
				userId: user.id,
				role: "assistant",
				content: general.answer,
				provider: "general",
				latencyMs: general.latencyMs,
				citations: [],
			})
			recordActivity(db, {
				tenantId: tenant.id,
				userId: user.id,
				userName: user.name,
				action: "General Question",
				resourceType: "conversation",
				resourceId: conversation.id,
				status: "success",
				detail: general.isFallback ? `no model: ${general.fallbackReason ?? "fallback"}` : `model=${general.model}`,
				requestId,
				latencyMs: general.latencyMs,
			})
			return sendJson(res, 200, {
				conversationId: conversation.id,
				message: generalMessage,
				retrieval: null,
				security: null,
				model: { provider: general.provider, model: general.model, isFallback: general.isFallback, fallbackReason: general.fallbackReason },
				workflow: null,
			})
		}

		const assistant = services.conversations.addMessage({
			tenantId: tenant.id,
			conversationId: conversation.id,
			userId: user.id,
			role: "assistant",
			content: result.answer,
			grounding: result.grounding,
			confidence: result.confidence,
			provider: result.provider,
			latencyMs: result.latencyMs,
			citations: result.citations,
		})

		recordActivity(db, {
			tenantId: tenant.id,
			userId: user.id,
			userName: user.name,
			action: result.grounding === "access_denied" ? "Restricted Knowledge Request" : "Knowledge Query",
			resourceType: "knowledge",
			status: result.grounding === "access_denied" ? "denied" : "success",
			detail: `grounding=${result.grounding} citations=${result.citations.length}`,
			requestId,
			latencyMs: result.latencyMs,
		})

		log.info("chat.completed", {
			requestId,
			tenantId: tenant.id,
			userId: user.id,
			latencyMs: result.latencyMs,
			grounding: result.grounding,
			citations: result.citations.length,
			retrievalStatus: result.retrieval.usedCount > 0 ? "hit" : "empty",
			userAttackFlags: result.security.userAttackFlags,
			documentInjectionFlags: result.security.documentInjectionFlags,
		})

		sendJson(res, 200, {
			conversationId: conversation.id,
			message: assistant,
			retrieval: { ...result.retrieval, strategy: result.retrieval.provider },
			security: result.security,
			model: { provider: result.provider, model: result.model, isFallback: result.isFallback, fallbackReason: result.fallbackReason },
			workflow: null,
		})
	})

	router.post("/api/messages/:id/feedback", async ({ req, res, params }) => {
		const identity = await requireIdentity(services, req)
		enforceRateLimit(req, res, "feedback")
		const messageId = requireId(params.id, "message id")
		const body = await readJson<{ feedback?: "up" | "down" | null }>(req)
		const value = body.feedback ?? null
		if (value !== null && value !== "up" && value !== "down") {
			throw new HttpError(400, "Feedback must be up, down or null.", "malformed_request")
		}
		// Knowing a message id is not permission to rate it.
		if (!services.conversations.ownsMessage(identity.tenant.id, identity.user.id, messageId)) {
			throw new HttpError(404, "Message not found.", "not_found")
		}
		services.conversations.setFeedback(identity.tenant.id, messageId, value)
		sendJson(res, 200, { ok: true })
	})

	/* ---- knowledge (read) ---------------------------------------------- */

	router.get("/api/knowledge", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		// Documents the caller may not read are never listed.
		const documents = services.documents
			.listDocuments(identity.tenant.id)
			.filter(
				(doc) =>
					decideDocumentAccess(identity.scope, {
						tenantId: doc.tenantId,
						documentId: doc.id,
						department: doc.department,
						classification: doc.classification,
						allowedRoles: doc.allowedRoles,
						allowedUsers: doc.allowedUsers,
					}).allowed,
			)
		// Statistics follow the same permission boundary as the list itself. A
		// non-admin caller must not learn how many restricted documents exist,
		// nor the names of departments whose shelves they cannot open: a count is
		// still disclosure. Administrators keep the full tenant-wide figures.
		const stats = identity.scope.isAdmin
			? services.documents.stats(identity.tenant.id)
			: scopedDocumentStats(documents)
		sendJson(res, 200, { documents, stats })
	})

	/* ---- knowledge (write) --------------------------------------------- */

	const uploadHandler = async ({ req, res, requestId }: Ctx) => {
		const identity = await requireIdentity(services, req)
		if (!identity.scope.canUploadKnowledge && !identity.scope.isAdmin) {
			throw new HttpError(403, "Your role cannot upload knowledge.", "forbidden")
		}
		const contentType = String(req.headers["content-type"] ?? "")
		if (!contentType.includes("multipart/form-data")) {
			throw new HttpError(415, "Upload must be multipart/form-data.", "unsupported_media_type")
		}
		const { fields, files } = parseMultipart(await readBody(req), contentType)
		if (files.length === 0) throw new HttpError(400, "No file was uploaded.", "malformed_request")

		const results = []
		for (const file of files) {
			const result = await services.documents.ingest({
				tenantId: identity.tenant.id,
				filename: file.filename,
				buffer: file.data,
				// Validated for consistency with the extension; never trusted alone.
				mimeType: file.contentType,
				uploadedBy: identity.user.name,
				title: fields.title,
				department: fields.department,
				category: fields.category,
				classification: fields.classification ? asClassification(fields.classification) : undefined,
				version: fields.version,
				effectiveDate: fields.effectiveDate,
				allowedRoles: toList(fields.allowedRoles),
				allowedUsers: toList(fields.allowedUsers),
			})
			results.push(result)
			recordActivity(db, {
				tenantId: identity.tenant.id,
				userId: identity.user.id,
				userName: identity.user.name,
				action: "Document Ingested",
				resourceType: "document",
				resourceId: result.document.id,
				status: "success",
				detail: `${result.document.filename} v${result.version.version}, ${result.chunkCount} chunks`,
				requestId,
			})
		}
		sendJson(res, 201, { message: "Knowledge base ready.", results })
	}

	router.post("/api/knowledge/upload", async (ctx) => {
		enforceRateLimit(ctx.req, ctx.res, "upload")
		await uploadHandler(ctx)
	})

	/**
	 * Authenticated, backend-mediated download of an original document file.
	 *
	 * The client sends identifiers only - never a storage path, container or
	 * object key. Authorization runs against Neon (tenant + document ACL +
	 * classification) inside DocumentService.readVersionFile before the storage
	 * provider is touched, and the bytes are streamed through this process. No
	 * SAS URL, public URL or container listing is ever exposed.
	 */
	router.get("/api/knowledge/:id/versions/:versionId/file", async ({ req, res, params, requestId }) => {
		const identity = await requireIdentity(services, req)
		const documentId = requireId(params.id, "document id")
		const versionId = requireId(params.versionId, "version id")
		const file = await services.documents.readVersionFile(identity.scope, identity.tenant.id, documentId, versionId)
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: "Document Downloaded",
			resourceType: "document_version",
			resourceId: versionId,
			status: "success",
			detail: `${file.filename} v${file.version.version}`,
			requestId,
		})
		res.writeHead(200, {
			"content-type": file.contentType,
			"content-disposition": `attachment; filename="${safeDownloadName(file.filename)}"`,
			"cache-control": "no-store",
			...(file.size > 0 ? { "content-length": String(file.size) } : {}),
		})
		file.stream.on("error", () => res.destroy())
		file.stream.pipe(res)
	})

	router.patch("/api/knowledge/:id", async ({ req, res, params }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		const body = await readJson<Record<string, unknown>>(req)
		const patch: Record<string, unknown> = {}
		if (body.title) patch.title = String(body.title)
		if (body.department) patch.department = String(body.department)
		if (body.category) patch.category = String(body.category)
		if (body.classification) patch.classification = asClassification(body.classification)
		if (body.allowedRoles !== undefined) patch.allowedRoles = toList(body.allowedRoles)
		if (body.allowedUsers !== undefined) patch.allowedUsers = toList(body.allowedUsers)
		const document = await services.documents.updateMetadata(identity.tenant.id, params.id, patch as any)
		if (body.status === "active" || body.status === "inactive") {
			await services.documents.setDocumentStatus(identity.tenant.id, params.id, body.status)
		}
		sendJson(res, 200, { document: services.documents.getDocument(identity.tenant.id, params.id) ?? document })
	})

	router.post("/api/knowledge/:id/versions/:versionId/activate", async ({ req, res, params, requestId }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		const version = await services.documents.activateVersion(identity.tenant.id, params.id, params.versionId)
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: "Version Activated",
			resourceType: "document_version",
			resourceId: version.id,
			status: "success",
			detail: `v${version.version}`,
			requestId,
		})
		sendJson(res, 200, { version })
	})

	router.post("/api/knowledge/:id/versions/:versionId/deactivate", async ({ req, res, params }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		await services.documents.deactivateVersion(identity.tenant.id, params.id, params.versionId)
		sendJson(res, 200, { ok: true })
	})

	router.delete("/api/knowledge/:id", async ({ req, res, params, requestId }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		await services.documents.deleteDocument(identity.tenant.id, params.id)
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: "Document Deleted",
			resourceType: "document",
			resourceId: params.id,
			status: "success",
			requestId,
		})
		sendJson(res, 200, { ok: true })
	})

	/* ---- admin --------------------------------------------------------- */

	router.get("/api/admin/metrics", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		const tenantId = identity.tenant.id
		const incidents = await services.providers.actions.listIncidents(tenantId, 100).catch(() => [])
		// Observational only: like /api/health, admin metrics must never trigger
		// model inference or any other remote provider call.
		const adminConfig = getConfig()
		const adminReadiness = computeAzureReadiness(
			adminConfig.modes,
			{
				llm: services.providers.llm,
				embeddings: services.providers.embeddings,
				knowledge: services.providers.knowledge,
				vectorStore: services.providers.vectorStore,
				auth: services.auth,
				actions: services.providers.actions,
				// Configuration state only: admin metrics never probe Blob Storage.
				storage: services.providers.storage,
			},
			azureConfigSnapshot(adminConfig),
		)
		sendJson(res, 200, {
			documents: services.documents.stats(tenantId),
			conversations: services.conversations.metrics(tenantId),
			users: listUsers(db, tenantId).length,
			roles: listRoles(db, tenantId).length,
			incidents: { total: incidents.length, open: incidents.filter((i) => i.status === "open").length, recent: incidents.slice(0, 5) },
			/**
			 * Phase 8. Counted from the local action_requests audit table only - a
			 * plain SQL read, so /api/admin/metrics stays a zero-token, zero-remote
			 * endpoint exactly as before.
			 */
			actions: (() => {
				const requests = services.actions.list(identity.scope, { limit: 200, all: true })
				const byStatus: Record<string, number> = {}
				for (const request of requests) byStatus[request.status] = (byStatus[request.status] ?? 0) + 1
				return {
					total: requests.length,
					succeeded: byStatus.succeeded ?? 0,
					failed: byStatus.failed ?? 0,
					awaitingConfirmation: byStatus.awaiting_confirmation ?? 0,
					rejected: byStatus.rejected ?? 0,
					executor: services.actions.executorName,
					simulated: services.actions.simulated,
					recent: requests.slice(0, 5),
				}
			})(),
			knowledgeSources: [
				{
					name: services.providers.knowledge.name,
					mode: services.providers.knowledge.mode,
					// Configuration state, not a live probe result.
					status: adminReadiness.components.knowledge?.state ?? "local",
				},
			],
			system: {
				modeBadge: adminReadiness.badge,
				azureConfigured: adminReadiness.azureConfigured,
				azurePartial: adminReadiness.partial,
				liveProbe: false,
				llm: { name: services.providers.llm.name, model: services.providers.llm.model },
				embeddings: { model: services.providers.embeddings.model },
				vectorStore: services.providers.vectorStore.mode,
				storage: services.providers.storage.mode,
				auth: services.auth.mode,
				actions: services.providers.actions.mode,
			},
		})
	})

	router.get("/api/admin/activity", async ({ req, res, url }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		const limit = boundedLimit(url.searchParams.get("limit"), 100, 500)
		sendJson(res, 200, { activity: listActivity(db, identity.tenant.id, limit) })
	})

	router.get("/api/admin/users", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		sendJson(res, 200, { users: listUsers(db, identity.tenant.id), roles: listRoles(db, identity.tenant.id) })
	})

	/* ---- Entra identity administration ---------------------------------
	 * Linking a Microsoft identity to a NOVA user is an ADMINISTRATOR action.
	 * A normal employee can never claim another person's Entra identity, and
	 * a link is never inferred from an email address or domain.
	 */
	const ENTRA_OBJECT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

	router.post("/api/admin/users/:id/entra-link", async ({ req, res, params, requestId }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		enforceRateLimit(req, res, "adminWrite")
		const body = await readJson<{ entraObjectId?: string; entraUpn?: string }>(req)
		const objectId = String(body.entraObjectId ?? "").trim()
		if (!ENTRA_OBJECT_ID.test(objectId)) {
			throw new HttpError(400, "A valid Microsoft Entra object ID (GUID) is required.", "malformed_request")
		}
		const user = linkEntraIdentity(db, {
			tenantId: identity.tenant.id,
			userId: requireId(params.id, "user id"),
			entraObjectId: objectId,
			entraUpn: body.entraUpn ? String(body.entraUpn).slice(0, 320) : null,
		})
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: "Entra Identity Linked",
			resourceType: "user",
			resourceId: user.id,
			status: "success",
			requestId,
		})
		sendJson(res, 200, { user })
	})

	router.delete("/api/admin/users/:id/entra-link", async ({ req, res, params, requestId }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		enforceRateLimit(req, res, "adminWrite")
		const user = unlinkEntraIdentity(db, identity.tenant.id, requireId(params.id, "user id"))
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: "Entra Identity Unlinked",
			resourceType: "user",
			resourceId: user.id,
			status: "success",
			requestId,
		})
		sendJson(res, 200, { user })
	})

	/** Approve (or suspend) a user. Role and department stay explicit choices. */
	router.post("/api/admin/users/:id/status", async ({ req, res, params, requestId }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		enforceRateLimit(req, res, "adminWrite")
		const body = await readJson<{ status?: string }>(req)
		const status = String(body.status ?? "")
		if (status !== "active" && status !== "pending" && status !== "disabled") {
			throw new HttpError(400, "status must be active, pending or disabled.", "malformed_request")
		}
		const user = setUserStatus(db, identity.tenant.id, requireId(params.id, "user id"), status)
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: "User Status Changed",
			resourceType: "user",
			resourceId: user.id,
			status: "success",
			detail: `status: ${status}`,
			requestId,
		})
		sendJson(res, 200, { user })
	})

	router.post("/api/admin/users", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		enforceRateLimit(req, res, "adminWrite")
		const body = await readJson<Record<string, string>>(req)
		if (!body.name || !body.email || !body.roleKey) {
			throw new HttpError(400, "name, email and roleKey are required.", "malformed_request")
		}
		sendJson(res, 201, {
			user: upsertUser(db, {
				tenantId: identity.tenant.id,
				name: requireText(body.name, "name", 160),
				email: requireText(body.email, "email", 320),
				roleKey: requireId(body.roleKey, "roleKey"),
				department: body.department || "General",
				title: body.title,
			}),
		})
	})

	router.get("/api/admin/roles", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		sendJson(res, 200, {
			roles: listRoles(db, identity.tenant.id),
			permissions: listPermissions(db, identity.tenant.id),
			departments: identity.tenant.settings.departments,
			classifications: CLASSIFICATIONS,
		})
	})

	router.post("/api/admin/roles", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		enforceRateLimit(req, res, "adminWrite")
		const body = await readJson<Record<string, any>>(req)
		if (!body.key || !body.name) throw new HttpError(400, "key and name are required.", "malformed_request")
		const role = upsertRole(db, {
			tenantId: identity.tenant.id,
			key: String(body.key).toUpperCase().replace(/\s+/g, "_"),
			name: String(body.name),
			description: body.description ? String(body.description) : "",
			isAdmin: Boolean(body.isAdmin),
			canCreateIncidents: body.canCreateIncidents !== false,
			canUploadKnowledge: Boolean(body.canUploadKnowledge),
		})
		for (const grant of Array.isArray(body.permissions) ? body.permissions : []) {
			grantPermission(db, {
				tenantId: identity.tenant.id,
				roleKey: role.key,
				department: String(grant.department || "*"),
				maxClassification: asClassification(grant.maxClassification),
			})
		}
		sendJson(res, 201, { role, permissions: listPermissions(db, identity.tenant.id, role.key) })
	})

	router.get("/api/admin/settings", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		const config = getConfig()
		sendJson(res, 200, {
			tenant: identity.tenant,
			modes: config.modes,
			isFullyLocal: config.isFullyLocal,
			retrieval: config.retrieval,
			embeddingModel: services.providers.embeddings.model,
			llmModel: services.providers.llm.model,
			classifications: CLASSIFICATIONS,
		})
	})

	router.patch("/api/admin/settings", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		enforceRateLimit(req, res, "adminWrite")
		const body = await readJson<Record<string, any>>(req)
		const patch: Record<string, unknown> = {}
		if (Array.isArray(body.departments)) patch.departments = body.departments.map(String)
		if (body.assistantName) patch.assistantName = String(body.assistantName)
		if (body.currency) patch.currency = String(body.currency)
		if (body.defaultClassification) patch.defaultClassification = asClassification(body.defaultClassification)
		if (body.knowledgeScopeNote !== undefined) patch.knowledgeScopeNote = String(body.knowledgeScopeNote)
		sendJson(res, 200, { tenant: updateTenantSettings(db, identity.tenant.id, patch as any) })
	})

	/* ---- incidents ------------------------------------------------------ */

	router.get("/api/incidents", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		const incidents = await services.providers.actions.listIncidents(identity.tenant.id, 100).catch(() => [])
		sendJson(res, 200, { incidents, simulated: services.providers.actions.simulated })
	})

	/* ---- governed enterprise actions (Phase 8) --------------------------
	 *
	 * Four routes, and the governance is identical for every action because it
	 * lives in GovernedActionService rather than in these handlers:
	 *
	 *   GET  /api/actions                 the catalogue + whether YOU may run each
	 *   POST /api/actions/propose         validate + authorize + audit, no execution
	 *   POST /api/actions/:id/confirm     RE-authorize, then execute
	 *   GET  /api/actions/requests        your own audit trail
	 *
	 * The tenant is never read from a body or a query string on any of them: it
	 * comes from requireIdentity(), i.e. from the verified bearer token.
	 */

	router.get("/api/actions", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		sendJson(res, 200, {
			actions: services.actions.catalog(identity.scope),
			executor: services.actions.executorName,
			/** True in local mode: the UI must label the outcome SIMULATED ACTION. */
			simulated: services.actions.simulated,
		})
	})

	router.get("/api/actions/requests", async ({ req, res, url }) => {
		const identity = await requireIdentity(services, req)
		// `all=true` is honoured only for administrators; for anyone else it is
		// ignored rather than refused, so the flag is not an existence oracle.
		const all = url.searchParams.get("all") === "true" && identity.scope.isAdmin
		sendJson(res, 200, {
			requests: services.actions.list(identity.scope, { limit: boundedLimit(url.searchParams.get("limit"), 50, 200), all }),
			scope: all ? "tenant" : "self",
		})
	})

	router.post("/api/actions/propose", async ({ req, res, requestId }) => {
		// State-changing and authenticated: rate limited on the action bucket.
		enforceRateLimit(req, res, "action")
		const identity = await requireIdentity(services, req)
		const body = await readJson<Record<string, unknown>>(req)
		const { record, definition } = await services.actions.propose({
			scope: identity.scope,
			actor: {
				userId: identity.user.id,
				name: identity.user.name,
				email: identity.user.email,
				roleKey: identity.user.roleKey,
				department: identity.user.department,
			},
			actionId: body.actionId,
			input: body.input,
			conversationId: optionalId(body.conversationId, "conversationId") ?? null,
			sourceDocumentId: optionalId(body.sourceDocumentId, "sourceDocumentId") ?? null,
			sourceVersionId: optionalId(body.sourceVersionId, "sourceVersionId") ?? null,
			requestId,
		})
		sendJson(res, 201, {
			request: record,
			/** The exact sentence the user must agree to. Rendered verbatim. */
			confirmation: {
				required: record.status === "awaiting_confirmation",
				prompt: definition.summarize(record.input),
				warning: services.actions.simulated
					? "This will write to a real enterprise system and cannot be undone from NOVA."
					: "This will write to a real enterprise system and cannot be undone from NOVA.",
			},
		})
	})

	router.post("/api/actions/:id/confirm", async ({ req, res, params, requestId }) => {
		enforceRateLimit(req, res, "action")
		const identity = await requireIdentity(services, req)
		const body = await readJson<Record<string, unknown>>(req)
		/**
		 * Note what is NOT read from this body: the action id, the tenant, the
		 * actor and - above all - the input. The confirmation carries a decision
		 * and nothing else, so it cannot be used to execute different arguments
		 * from the ones the person was shown.
		 */
		const { record } = await services.actions.confirm({
			scope: identity.scope,
			actor: {
				userId: identity.user.id,
				name: identity.user.name,
				email: identity.user.email,
				roleKey: identity.user.roleKey,
				department: identity.user.department,
			},
			actionRequestId: requireId(params.id, "action request id"),
			confirm: body.confirm,
			requestId,
		})
		sendJson(res, 200, { request: record, simulated: record.simulated })
	})

	/* ---- action permissions (administrator only) ------------------------ */

	router.get("/api/admin/action-permissions", async ({ req, res }) => {
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		sendJson(res, 200, {
			/** The closed set of keys the shipped registry can require. */
			permissions: ACTION_PERMISSIONS,
			roles: listRoles(db, identity.tenant.id),
			grants: listActionPermissionGrants(db, identity.tenant.id),
		})
	})

	router.post("/api/admin/action-permissions", async ({ req, res, requestId }) => {
		enforceRateLimit(req, res, "adminWrite")
		const identity = await requireIdentity(services, req)
		requireAdmin(identity)
		const body = await readJson<Record<string, unknown>>(req)
		const roleKey = requireId(body.roleKey, "roleKey")
		const actionPermission = String(body.actionPermission ?? "")
		// Only permissions the registry actually declares may be granted: an
		// unknown key would sit in the table forever, authorising nothing and
		// misleading the next reviewer.
		if (!ACTION_PERMISSIONS.includes(actionPermission)) {
			throw new HttpError(400, "Unknown action permission.", "malformed_request")
		}
		if (!listRoles(db, identity.tenant.id).some((role) => role.key === roleKey)) {
			throw new HttpError(404, "Role not found.", "not_found")
		}
		const granted = body.granted !== false
		if (granted) {
			grantActionPermission(db, {
				tenantId: identity.tenant.id,
				roleKey,
				actionPermission,
				grantedBy: identity.user.id,
			})
		} else {
			revokeActionPermission(db, { tenantId: identity.tenant.id, roleKey, actionPermission })
		}
		recordActivity(db, {
			tenantId: identity.tenant.id,
			userId: identity.user.id,
			userName: identity.user.name,
			action: granted ? "Action Permission Granted" : "Action Permission Revoked",
			resourceType: "action_permission",
			resourceId: `${roleKey}:${actionPermission}`,
			status: "success",
			requestId,
		})
		sendJson(res, 200, { grants: listActionPermissionGrants(db, identity.tenant.id) })
	})

	/* ---- onboarding (self-service tenant creation) ---------------------- */

	router.post("/api/onboarding/tenants", async ({ req, res, requestId }) => {
		// Public, state-changing, and it provisions a workspace: the tightest
		// budget in the system, plus the same-origin guard.
		enforceRateLimit(req, res, "onboarding")
		assertSameOrigin(req)
		/**
		 * Self-service onboarding mints an ADMIN user and a session for an
		 * anonymous caller. That is acceptable for the local demo; in Entra
		 * mode it would be an anonymous path to an administrator identity, so
		 * it is closed. Workspaces are provisioned by an administrator instead.
		 */
		if (services.auth.mode !== "demo") {
			throw new HttpError(403, "Self-service onboarding is disabled when Microsoft Entra ID authentication is enabled.", "forbidden")
		}
		const body = await readJson<Record<string, any>>(req)
		const tenantName = requireText(body.name, "A company name", 160)
		const tenant = createTenant(db, {
			name: tenantName,
			industry: String(body.industry || "Other"),
			settings: {
				departments: Array.isArray(body.departments) && body.departments.length ? body.departments.map(String) : undefined,
				currency: body.currency ? String(body.currency) : undefined,
			} as any,
		})
		// A brand-new workspace gets a minimal, industry-neutral role set plus an
		// administrator so the customer can immediately upload knowledge.
		upsertRole(db, {
			tenantId: tenant.id,
			key: "ADMIN",
			name: "Enterprise Administrator",
			isAdmin: true,
			canUploadKnowledge: true,
		})
		upsertRole(db, { tenantId: tenant.id, key: "EMPLOYEE", name: "Employee" })
		grantPermission(db, { tenantId: tenant.id, roleKey: "ADMIN", department: "*", maxClassification: "restricted" })
		grantPermission(db, { tenantId: tenant.id, roleKey: "EMPLOYEE", department: "*", maxClassification: "internal" })
		const admin = upsertUser(db, {
			tenantId: tenant.id,
			name: String(body.adminName || "Workspace Administrator").slice(0, 160),
			email: String(body.adminEmail || `admin@${tenant.slug}.example`).slice(0, 320),
			roleKey: "ADMIN",
			department: "Management",
			title: "Administrator",
		})
		recordActivity(db, {
			tenantId: tenant.id,
			userId: admin.id,
			userName: admin.name,
			action: "Tenant Created",
			resourceType: "tenant",
			resourceId: tenant.id,
			status: "success",
			requestId,
		})
		const session = await services.auth.createSession({ tenantId: tenant.id, userId: admin.id })
		sendJson(res, 201, { tenant, admin, session })
	})

	return router
}

/* ---------------------------- static assets ----------------------------- */

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".avif": "image/avif",
	".mp4": "video/mp4",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
}

function serveStatic(res: ServerResponse, pathname: string): boolean {
	const root = path.resolve(getConfig().paths.webDist)
	if (!fs.existsSync(root)) return false
	const candidate = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`)
	const target = candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
		? candidate
		: path.join(root, "index.html")
	if (!fs.existsSync(target)) return false
	const body = fs.readFileSync(target)
	res.writeHead(200, {
		"content-type": MIME[path.extname(target)] ?? "application/octet-stream",
		"content-length": body.byteLength,
		"cache-control": path.extname(target) === ".html" ? "no-store" : "public, max-age=300",
	})
	res.end(body)
	return true
}

/* ------------------------------- server ---------------------------------- */

function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
	if (error instanceof HttpError) return { status: error.statusCode, body: { error: error.message, code: error.code } }
	if (error instanceof AuthError) {
		// 401 = authentication failed, 403 = authenticated but not authorized
		// inside NOVA (unlinked or pending identity). The body never contains
		// token contents, claims, signing keys or raw Entra text.
		return { status: error.statusCode, body: { error: error.message, code: error.code } }
	}
	if (error instanceof IdentityLinkError) {
		return { status: error.statusCode, body: { error: error.message, code: "identity_link_error" } }
	}
	/**
	 * Phase 8. GovernedActionError already carries a closed, documented code and
	 * a message written for a person, so it is returned as-is. `fields` is the
	 * per-field validation detail for invalid_input and is present only then.
	 * The endpoint of the Function app, its key and any upstream response body
	 * were logged at the executor, never here.
	 */
	if (error instanceof GovernedActionError) {
		return {
			status: error.statusCode,
			body: {
				error: error.message,
				code: error.code,
				...(Object.keys(error.fields).length > 0 ? { fields: error.fields } : {}),
			},
		}
	}
	if (error instanceof DocumentError) return { status: error.statusCode, body: { error: error.message, code: "document_error" } }
	if (error instanceof StorageError) {
		// The provider already decided the PUBLIC status and message. The
		// category, upstream status and request id are logged; the connection
		// string, account key and upstream text never leave the process.
		log.error("storage.error", {
			category: error.category,
			upstreamStatus: error.upstreamStatus,
			requestId: error.requestId,
			detail: error.message,
		})
		return { status: error.statusCode, body: { error: error.publicMessage, code: "storage_error", category: error.category } }
	}
	const anyError = error as { name?: string; statusCode?: number; message?: string }
	if (anyError?.name === "ActionError") {
		return { status: anyError.statusCode ?? 400, body: { error: anyError.message ?? "Action failed.", code: "action_error" } }
	}
	if (anyError?.name === "LLMError" || anyError?.name === "EmbeddingError") {
		// The provider already decided the PUBLIC status (see publicStatusFor in
		// azure/foundry.ts): 429 for rate limits, 504 for timeouts, 502 otherwise.
		// The upstream status and category are logged, never returned, so a
		// misconfigured deployment cannot leak details to a browser.
		const provider = error as {
			statusCode?: number
			category?: string
			upstreamStatus?: number
			requestId?: string
			message?: string
		}
		log.error("provider.error", {
			kind: anyError.name,
			category: provider.category ?? "unknown",
			upstreamStatus: provider.upstreamStatus,
			requestId: provider.requestId,
			detail: provider.message,
		})
		const status = provider.statusCode === 429 || provider.statusCode === 504 ? provider.statusCode : 502
		const message =
			status === 429
				? "The answering model is rate limited. Please retry shortly."
				: status === 504
					? "The answering model timed out. Please retry."
					: "The answering model is unavailable. Please retry."
		return {
			status,
			body: {
				error: message,
				code: anyError.name === "EmbeddingError" ? "embedding_error" : "model_error",
				// Category is a fixed vocabulary, not provider text: safe to expose
				// and useful for operators reading the network tab.
				category: provider.category ?? "upstream",
			},
		}
	}
	if (anyError?.name === "ConfigError") {
		log.error("config.invalid", { detail: anyError.message })
		return { status: 500, body: { error: "Server configuration is invalid.", code: "config_error" } }
	}
	// Unexpected: log internally, return a generic message (never a stack trace).
	log.error("request.unhandled", { detail: anyError?.message ?? String(error) })
	return { status: 500, body: { error: "Something went wrong. Please try again.", code: "internal_error" } }
}

/**
 * The request handler, independent of the transport. Identical logic is served
 * over HTTP and HTTPS, so enabling TLS can never change application behaviour.
 */
function buildRequestHandler(services: Services): http.RequestListener {
	const router = buildRouter(services)
	return async (req, res) => {
		const requestId = newRequestId()
		const started = Date.now()
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
		res.setHeader("x-request-id", requestId)
		// Applied to API and static responses alike, before any handler runs.
		applySecurityHeaders(req, res)
		try {
			const matched = router.match(req.method ?? "GET", url.pathname)
			if (matched) {
				await matched.handler({ req, res, url, params: matched.params, requestId })
				log.debug("request.completed", {
					requestId,
					method: req.method,
					path: url.pathname,
					status: res.statusCode,
					latencyMs: Date.now() - started,
				})
				return
			}
			if (url.pathname.startsWith("/api/")) {
				return sendJson(res, 404, { error: "Not found.", code: "not_found" })
			}
			if (req.method === "GET" && serveStatic(res, url.pathname)) return
			sendJson(res, 404, { error: "Not found.", code: "not_found" })
		} catch (error) {
			const { status, body } = errorResponse(error)
			log.warn("request.failed", {
				requestId,
				method: req.method,
				path: url.pathname,
				status,
				latencyMs: Date.now() - started,
				detail: body.error,
			})
			if (!res.headersSent) sendJson(res, status, { ...body, requestId })
			else res.end()
		}
	}
}

/**
 * Creates the server. Plain HTTP by default, which is what local development
 * and a TLS-terminating proxy both expect. With HTTPS_ENABLED=true NOVA
 * terminates TLS itself using the configured certificate; a certificate that
 * cannot be read fails startup rather than silently downgrading.
 */
export function createServer(services: Services = createServices()): http.Server | https.Server {
	const handler = buildRequestHandler(services)
	const tls = resolveTlsMaterial(getConfig())
	if (!tls) return http.createServer(handler)
	// Only the certificate path is ever reported; the private key stays in memory.
	log.info("server.tls_enabled", { certFile: tls.certFile })
	return https.createServer({ key: tls.key, cert: tls.cert }, handler)
}
// hist: 2026-09-20T14:55:19+05:30
