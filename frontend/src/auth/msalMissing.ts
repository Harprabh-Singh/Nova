/**
 * Build-time stand-in for @azure/msal-browser.
 *
 * It is substituted ONLY when the package is not installed, so a local/demo
 * build (AUTH_MODE=demo, which never signs in with Microsoft) still succeeds
 * offline. Any attempt to actually use Entra sign-in fails loudly here rather
 * than silently degrading to a weaker authentication path.
 */
const message = "Microsoft Entra sign-in requires @azure/msal-browser. Run `npm install`, then rebuild the frontend."

export class PublicClientApplication {
	constructor(_configuration: unknown) {
		throw new Error(message)
	}
}

export class InteractionRequiredAuthError extends Error {}

export type AccountInfo = { homeAccountId: string; username: string; name?: string }
export type AuthenticationResult = { account: AccountInfo | null; accessToken: string }
export type IPublicClientApplication = Record<string, never>
export type RedirectRequest = { scopes: string[]; prompt?: string }
export type PopupRequest = RedirectRequest
