import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api, setToken, getToken, setTokenProvider } from "../services/api.ts"
import type { AuthConfigResponse, HealthResponse, Me, Persona } from "../types/index.ts"
import {
	acquireNovaApiToken,
	getEntraAccount,
	initEntra,
	signInWithEntra,
	signOutFromEntra,
	type EntraAccount,
	type EntraPublicConfig,
} from "../auth/entraClient.ts"

/**
 * One session context, two providers behind it:
 *
 *   AUTH_MODE=demo   persona selection -> HMAC session token (local demo)
 *   AUTH_MODE=entra  Microsoft sign-in -> MSAL access token for the NOVA API
 *
 * The frontend never decides who you are. It only carries a bearer token; the
 * backend validates it and resolves tenant, role, department, clearance and
 * permissions from Neon.
 */

type AuthMode = "demo" | "entra"
export type AuthPhase = "loading" | "signed-out" | "signing-in" | "signed-in" | "error"

type SessionValue = {
	ready: boolean
	health: HealthResponse | null
	me: Me | null
	personas: Persona[]
	personaNotice: string
	tenants: Array<{ id: string; name: string; slug: string; industry: string; departments: string[] }>
	error: string | null
	/** Which authentication provider the backend is running. */
	authMode: AuthMode
	authPhase: AuthPhase
	/** Authentication-specific error (invalid token, unlinked identity, …). */
	authError: string | null
	/** The signed-in Microsoft account, in Entra mode only. */
	entraAccount: EntraAccount | null
	signIn: (input: { tenantId?: string; userId?: string; email?: string }) => Promise<void>
	signInWithMicrosoft: () => Promise<void>
	signOut: () => void
	refresh: () => Promise<void>
	loadPersonas: (tenantId?: string) => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

function toClientConfig(config: AuthConfigResponse): EntraPublicConfig | null {
	if (config.authMode !== "entra" || !config.entra) return null
	return {
		clientId: config.entra.clientId,
		tenantId: config.entra.tenantId,
		authority: config.entra.authority,
		apiScope: config.entra.apiScope,
		redirectUri: config.entra.redirectUri,
		postLogoutRedirectUri: config.entra.postLogoutRedirectUri,
	}
}

/**
 * Build-time public configuration (esbuild `define`). Used only as a fallback
 * when the backend config endpoint is unreachable. These are configuration
 * values, never secrets.
 */
declare const __VITE_ENTRA__: Partial<EntraPublicConfig> | undefined

function buildTimeConfig(): EntraPublicConfig | null {
	const values = typeof __VITE_ENTRA__ === "undefined" ? undefined : __VITE_ENTRA__
	if (!values?.clientId || !values.tenantId || !values.authority || !values.apiScope || !values.redirectUri) return null
	return values as EntraPublicConfig
}

export function SessionProvider({ children }: { children: ReactNode }) {
	const [ready, setReady] = useState(false)
	const [health, setHealth] = useState<HealthResponse | null>(null)
	const [me, setMe] = useState<Me | null>(null)
	const [personas, setPersonas] = useState<Persona[]>([])
	const [personaNotice, setPersonaNotice] = useState("")
	const [tenants, setTenants] = useState<SessionValue["tenants"]>([])
	const [error, setError] = useState<string | null>(null)
	const [authMode, setAuthMode] = useState<AuthMode>("demo")
	const [authPhase, setAuthPhase] = useState<AuthPhase>("loading")
	const [authError, setAuthError] = useState<string | null>(null)
	const [entraAccount, setEntraAccount] = useState<EntraAccount | null>(null)
	const entraConfig = useRef<EntraPublicConfig | null>(null)

	const loadPersonas = useCallback(async (tenantId?: string) => {
		try {
			const result = await api.personas(tenantId)
			setPersonas(result.personas)
			setPersonaNotice(result.notice)
		} catch {
			setPersonas([])
		}
	}, [])

	/** Boot: read the auth mode, then start the matching provider. */
	const refresh = useCallback(async () => {
		try {
			const [healthResult, tenantResult, configResult] = await Promise.all([
				api.health(),
				api.tenants().catch(() => ({ tenants: [] })),
				api.authConfig().catch(() => null),
			])
			setHealth(healthResult)
			setTenants(tenantResult.tenants)

			const mode: AuthMode = configResult?.authMode ?? "demo"
			setAuthMode(mode)

			if (mode === "entra") {
				/* ---------------- Microsoft Entra ID ---------------- */
				const config = toClientConfig(configResult!) ?? buildTimeConfig()
				entraConfig.current = config
				if (!config) {
					setAuthPhase("error")
					setAuthError("Microsoft Entra sign-in is not configured for this deployment.")
					return
				}
				// Every protected request gets a freshly acquired NOVA API token.
				setTokenProvider(async () => {
					try {
						return await acquireNovaApiToken(config)
					} catch {
						return null
					}
				})
				let account: EntraAccount | null = null
				try {
					account = await initEntra(config)
				} catch {
					setAuthPhase("error")
					setAuthError("Microsoft sign-in could not be completed. Please try again.")
					return
				}
				setEntraAccount(account ?? getEntraAccount())
				if (!account) {
					setMe(null)
					setAuthPhase("signed-out")
					return
				}
				try {
					const meResult = await api.me()
					setMe(meResult)
					setAuthPhase("signed-in")
					setAuthError(null)
				} catch (caught) {
					// Authenticated with Microsoft, but NOVA has not authorized
					// this identity (403) or the token was refused (401).
					setMe(null)
					setAuthPhase("error")
					setAuthError(caught instanceof Error ? caught.message : "NOVA could not authorize this Microsoft account.")
				}
				return
			}

			/* ---------------- local demo authentication ---------------- */
			setTokenProvider(null)
			if (getToken()) {
				try {
					const meResult = await api.me()
					setMe(meResult)
					setAuthPhase("signed-in")
					await loadPersonas(meResult.tenant.id)
				} catch {
					setToken(null)
					setMe(null)
					setAuthPhase("signed-out")
					await loadPersonas(tenantResult.tenants[0]?.id)
				}
			} else {
				setAuthPhase("signed-out")
				await loadPersonas(tenantResult.tenants[0]?.id)
			}
			setError(null)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Unable to reach the NOVA server.")
			setAuthPhase("error")
		} finally {
			setReady(true)
		}
	}, [loadPersonas])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const signIn = useCallback(
		async (input: { tenantId?: string; userId?: string; email?: string }) => {
			const session = await api.signIn(input)
			setToken(session.token)
			const meResult = await api.me()
			setMe(meResult)
			setAuthPhase("signed-in")
			await loadPersonas(meResult.tenant.id)
		},
		[loadPersonas],
	)

	const signInWithMicrosoft = useCallback(async () => {
		const config = entraConfig.current
		if (!config) {
			setAuthError("Microsoft Entra sign-in is not configured for this deployment.")
			return
		}
		setAuthError(null)
		setAuthPhase("signing-in")
		try {
			await signInWithEntra(config)
		} catch {
			setAuthPhase("error")
			setAuthError("Microsoft sign-in could not be started. Please try again.")
		}
	}, [])

	const signOut = useCallback(() => {
		setMe(null)
		setAuthPhase("signed-out")
		if (authMode === "entra" && entraConfig.current) {
			setEntraAccount(null)
			void signOutFromEntra(entraConfig.current).catch(() => {})
			return
		}
		setToken(null)
	}, [authMode])

	const value = useMemo<SessionValue>(
		() => ({
			ready,
			health,
			me,
			personas,
			personaNotice,
			tenants,
			error,
			authMode,
			authPhase,
			authError,
			entraAccount,
			signIn,
			signInWithMicrosoft,
			signOut,
			refresh,
			loadPersonas,
		}),
		[
			ready,
			health,
			me,
			personas,
			personaNotice,
			tenants,
			error,
			authMode,
			authPhase,
			authError,
			entraAccount,
			signIn,
			signInWithMicrosoft,
			signOut,
			refresh,
			loadPersonas,
		],
	)

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
	const value = useContext(SessionContext)
	if (!value) throw new Error("useSession must be used inside SessionProvider")
	return value
}
