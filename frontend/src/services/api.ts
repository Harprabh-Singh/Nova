import type {
	ActivityEntry,
	AdminMetrics,
	ChatResponse,
	Conversation,
	HealthResponse,
	KnowledgeDocument,
	Me,
	Message,
	Permission,
	Persona,
	Role,
} from "../types/index.ts"
import type { AuthConfigResponse, AuthMeResponse } from "../types/index.ts"
import type { ActionCatalogEntry, ActionProposeResponse, ActionRequest } from "../types/index.ts"

const TOKEN_KEY = "nova.token"

export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string | null): void {
	if (token) localStorage.setItem(TOKEN_KEY, token)
	else localStorage.removeItem(TOKEN_KEY)
}

/**
 * Bearer-token source for protected requests.
 *
 * Demo mode keeps the HMAC session token in localStorage. In Entra mode the
 * SessionProvider installs a provider backed by MSAL, so the Authorization
 * header is never assembled from an arbitrary storage value: it always comes
 * from MSAL's current account/session state (silent acquisition first).
 */
export type TokenProvider = () => Promise<string | null>

let tokenProvider: TokenProvider | null = null

export function setTokenProvider(provider: TokenProvider | null): void {
	tokenProvider = provider
}

async function authorizationToken(): Promise<string | null> {
	if (tokenProvider) return tokenProvider()
	return getToken()
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		/**
		 * Per-field validation detail, present only for structured validation
		 * failures (Phase 8 `invalid_input`). Never a stack trace or upstream body.
		 */
		readonly fields?: Record<string, string>,
	) {
		super(message)
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers)
	const token = await authorizationToken()
	if (token) headers.set("authorization", `Bearer ${token}`)
	if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json")

	let response: Response
	try {
		response = await fetch(path, { ...init, headers })
	} catch {
		throw new ApiError("Cannot reach the NOVA server. Is it running?", 0, "network")
	}
	const text = await response.text()
	const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
	if (!response.ok) {
		throw new ApiError(
			String(data.error ?? "Request failed."),
			response.status,
			data.code as string,
			(data.fields as Record<string, string> | undefined) ?? undefined,
		)
	}
	return data as T
}

export const api = {
	health: () => request<HealthResponse>("/api/health"),
	authConfig: () => request<AuthConfigResponse>("/api/auth/config"),
	authMe: () => request<AuthMeResponse>("/api/auth/me"),
	tenants: () => request<{ tenants: Array<{ id: string; name: string; slug: string; industry: string; departments: string[] }> }>("/api/tenants"),
	personas: (tenantId?: string) =>
		request<{ tenant: { id: string; name: string } | null; personas: Persona[]; notice: string }>(
			`/api/personas${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""}`,
		),
	signIn: (body: { tenantId?: string; userId?: string; email?: string }) =>
		request<{ token: string; principal: { userId: string; tenantId: string; name: string } }>("/api/session", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	me: () => request<Me>("/api/me"),

	conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
	conversation: (id: string) => request<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${id}`),
	deleteConversation: (id: string) => request<{ ok: true }>(`/api/conversations/${id}`, { method: "DELETE" }),
	chat: (body: { message: string; conversationId?: string }) =>
		request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify(body) }),
	feedback: (messageId: string, feedback: "up" | "down" | null) =>
		request<{ ok: true }>(`/api/messages/${messageId}/feedback`, { method: "POST", body: JSON.stringify({ feedback }) }),

	knowledge: () =>
		request<{ documents: KnowledgeDocument[]; stats: AdminMetrics["documents"] }>("/api/knowledge"),
	upload: (form: FormData) => request<{ message: string; results: Array<Record<string, any>> }>("/api/knowledge/upload", { method: "POST", body: form }),
	updateDocument: (id: string, patch: Record<string, unknown>) =>
		request<{ document: KnowledgeDocument }>(`/api/knowledge/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
	activateVersion: (id: string, versionId: string) =>
		request<{ version: unknown }>(`/api/knowledge/${id}/versions/${versionId}/activate`, { method: "POST" }),
	deactivateVersion: (id: string, versionId: string) =>
		request<{ ok: true }>(`/api/knowledge/${id}/versions/${versionId}/deactivate`, { method: "POST" }),
	/**
	 * Backend-mediated download. The client sends identifiers only: it never
	 * knows or supplies a storage path, container or object key, and no public
	 * or SAS URL exists.
	 */
	downloadUrl: (documentId: string, versionId: string) =>
		`/api/knowledge/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/file`,
	deleteDocument: (id: string) => request<{ ok: true }>(`/api/knowledge/${id}`, { method: "DELETE" }),

	metrics: () => request<AdminMetrics>("/api/admin/metrics"),
	activity: () => request<{ activity: ActivityEntry[] }>("/api/admin/activity"),
	users: () => request<{ users: Persona[]; roles: Role[] }>("/api/admin/users"),
	createUser: (body: Record<string, string>) => request<{ user: Persona }>("/api/admin/users", { method: "POST", body: JSON.stringify(body) }),
	/** Administrator-only: bind a Microsoft Entra object id to a NOVA user. */
	linkEntraIdentity: (userId: string, body: { entraObjectId: string; entraUpn?: string }) =>
		request<{ user: Persona }>(`/api/admin/users/${encodeURIComponent(userId)}/entra-link`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	unlinkEntraIdentity: (userId: string) =>
		request<{ user: Persona }>(`/api/admin/users/${encodeURIComponent(userId)}/entra-link`, { method: "DELETE" }),
	setUserStatus: (userId: string, status: "active" | "pending" | "disabled") =>
		request<{ user: Persona }>(`/api/admin/users/${encodeURIComponent(userId)}/status`, {
			method: "POST",
			body: JSON.stringify({ status }),
		}),
	roles: () =>
		request<{ roles: Role[]; permissions: Permission[]; departments: string[]; classifications: string[] }>("/api/admin/roles"),
	createRole: (body: Record<string, unknown>) => request<{ role: Role }>("/api/admin/roles", { method: "POST", body: JSON.stringify(body) }),
	settings: () => request<Record<string, any>>("/api/admin/settings"),
	updateSettings: (body: Record<string, unknown>) => request<Record<string, any>>("/api/admin/settings", { method: "PATCH", body: JSON.stringify(body) }),

	incidents: () => request<{ incidents: Array<Record<string, any>>; simulated: boolean }>("/api/incidents"),

	/* ------------- Phase 8: governed enterprise actions -----------------
	 * The client sends an action id and a flat input object. It never sends a
	 * tenant id, a user id or a permission: the server takes identity from the
	 * bearer token. Confirmation is a separate request carrying ONLY the
	 * decision, so the payload that executes is always the one the person saw.
	 */
	actionCatalog: () =>
		request<{ actions: ActionCatalogEntry[]; executor: string; simulated: boolean }>("/api/actions"),
	proposeAction: (body: {
		actionId: string
		input: Record<string, string | number | boolean>
		conversationId?: string
		sourceDocumentId?: string
		sourceVersionId?: string
	}) => request<ActionProposeResponse>("/api/actions/propose", { method: "POST", body: JSON.stringify(body) }),
	confirmAction: (actionRequestId: string, confirm: boolean) =>
		request<{ request: ActionRequest; simulated: boolean }>(
			`/api/actions/${encodeURIComponent(actionRequestId)}/confirm`,
			{ method: "POST", body: JSON.stringify({ confirm }) },
		),
	actionRequests: (all = false) =>
		request<{ requests: ActionRequest[]; scope: "self" | "tenant" }>(`/api/actions/requests${all ? "?all=true" : ""}`),
	actionPermissions: () =>
		request<{ permissions: string[]; roles: Role[]; grants: Array<{ roleKey: string; actionPermission: string }> }>(
			"/api/admin/action-permissions",
		),
	setActionPermission: (body: { roleKey: string; actionPermission: string; granted: boolean }) =>
		request<{ grants: Array<{ roleKey: string; actionPermission: string }> }>("/api/admin/action-permissions", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	onboard: (body: Record<string, unknown>) =>
		request<{ tenant: { id: string; name: string }; admin: Persona; session: { token: string } }>("/api/onboarding/tenants", {
			method: "POST",
			body: JSON.stringify(body),
		}),
}
