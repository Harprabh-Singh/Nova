/**
 * Microsoft Entra ID sign-in for the NOVA SPA.
 *
 * Flow: Authorization Code + PKCE through @azure/msal-browser (a PUBLIC
 * client). There is no client secret in the browser, no implicit grant, and
 * no password anywhere.
 *
 * Redirect handling: MSAL Browser v3/v4 completes a redirect by calling
 * `handleRedirectPromise()` on the page the redirect landed on. NOVA's
 * registered redirect URI is the application origin itself
 * (http://localhost:4317), which the Node server serves, so the documented
 * arrangement needs no separate "bridge" page: `initialize()` +
 * `handleRedirectPromise()` run once before the app renders, and the response
 * hash is consumed there. A dedicated redirect page is therefore deliberately
 * NOT added.
 *
 * The NOVA API is called with an access token for
 * api://<clientId>/access_as_user - never an ID token and never a Microsoft
 * Graph token. NOVA requests no Graph permission: the display name and
 * username come from the MSAL account record, and every authorization
 * attribute comes from the NOVA backend (Neon).
 */
import type {
	AccountInfo,
	AuthenticationResult,
	IPublicClientApplication,
	PopupRequest,
	RedirectRequest,
} from "@azure/msal-browser"

export type EntraPublicConfig = {
	clientId: string
	tenantId: string
	authority: string
	apiScope: string
	redirectUri: string
	postLogoutRedirectUri?: string
}

export type EntraAccount = { name: string; username: string; homeAccountId: string }

let app: IPublicClientApplication | null = null
let current: EntraPublicConfig | null = null
let initializing: Promise<IPublicClientApplication> | null = null
/** Guards against an endless interactive-redirect loop. */
let interactionInFlight = false

const INTERACTION_FLAG = "nova.entra.interaction"

function assertAuthority(config: EntraPublicConfig): void {
	const expected = `https://login.microsoftonline.com/${config.tenantId}`
	if (config.authority.replace(/\/+$/, "") !== expected) {
		throw new Error("Entra authority does not match the configured single-tenant directory.")
	}
}

async function load(config: EntraPublicConfig): Promise<IPublicClientApplication> {
	if (app && current && current.clientId === config.clientId) return app
	if (initializing) return initializing
	assertAuthority(config)
	initializing = (async () => {
		const msal = await import("@azure/msal-browser")
		const instance = new msal.PublicClientApplication({
			auth: {
				clientId: config.clientId,
				authority: config.authority,
				redirectUri: config.redirectUri,
				postLogoutRedirectUri: config.postLogoutRedirectUri || config.redirectUri,
				navigateToLoginRequestUrl: false,
			},
			cache: {
				// Session storage keeps tokens out of other tabs and clears them
				// when the browser session ends.
				cacheLocation: "sessionStorage",
				storeAuthStateInCookie: false,
			},
			system: {
				loggerOptions: {
					loggerCallback: (level: number, message: string, containsPii: boolean) => {
						if (containsPii) return;
						// Exclude token/secret materials just in case, though piiLoggingEnabled is false.
						if (message.toLowerCase().includes("token") || message.toLowerCase().includes("secret")) return;
						console.log(`[MSAL] level=${level}: ${message}`);
					},
					piiLoggingEnabled: false,
					logLevel: msal.LogLevel.Verbose,
				},
			},
		})
		await instance.initialize()
		app = instance
		current = config
		return instance
	})()
	try {
		return await initializing
	} finally {
		initializing = null
	}
}

/**
 * Initialize MSAL and consume a redirect response if the browser just came
 * back from Microsoft. Call once, before the app renders.
 */
export async function initEntra(config: EntraPublicConfig): Promise<EntraAccount | null> {
	const instance = await load(config)
	let result: AuthenticationResult | null = null
	try {
		result = await instance.handleRedirectPromise()
	} finally {
		sessionStorage.removeItem(INTERACTION_FLAG)
		interactionInFlight = false
	}
	if (result?.account) instance.setActiveAccount(result.account)
	else {
		const existing = instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? null
		if (existing) instance.setActiveAccount(existing)
	}
	return toAccount(instance.getActiveAccount())
}

function toAccount(account: AccountInfo | null): EntraAccount | null {
	if (!account) return null
	return {
		name: account.name ?? account.username ?? "",
		username: account.username ?? "",
		homeAccountId: account.homeAccountId,
	}
}

export function getEntraAccount(): EntraAccount | null {
	return app ? toAccount(app.getActiveAccount()) : null
}

/** Start an interactive sign-in. A redirect leaves the page. */
export async function signInWithEntra(config: EntraPublicConfig): Promise<void> {
	const instance = await load(config)
	if (interactionInFlight || sessionStorage.getItem(INTERACTION_FLAG)) return
	interactionInFlight = true
	sessionStorage.setItem(INTERACTION_FLAG, "1")
	const request: RedirectRequest & PopupRequest = { scopes: [config.apiScope], prompt: "select_account" }
	await instance.loginRedirect(request)
}

/**
 * The NOVA API access token. Silent first; interaction only when Microsoft
 * says interaction is required, and at most one interactive attempt per page
 * load, so the app can never spin in a redirect loop.
 */
export async function acquireNovaApiToken(config: EntraPublicConfig): Promise<string | null> {
	const instance = await load(config)
	const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? null
	if (!account) return null
	try {
		const result = await instance.acquireTokenSilent({ account, scopes: [config.apiScope] })
		return result.accessToken || null
	} catch (error) {
		const msal = await import("@azure/msal-browser")
		if (error instanceof msal.InteractionRequiredAuthError) {
			if (interactionInFlight || sessionStorage.getItem(INTERACTION_FLAG)) return null
			interactionInFlight = true
			sessionStorage.setItem(INTERACTION_FLAG, "1")
			await instance.acquireTokenRedirect({ account, scopes: [config.apiScope] })
			return null
		}
		throw error
	}
}

export async function signOutFromEntra(config: EntraPublicConfig): Promise<void> {
	const instance = await load(config)
	const account = instance.getActiveAccount() ?? undefined
	instance.setActiveAccount(null)
	sessionStorage.removeItem(INTERACTION_FLAG)
	await instance.logoutRedirect({
		account,
		postLogoutRedirectUri: config.postLogoutRedirectUri || config.redirectUri,
	})
}
