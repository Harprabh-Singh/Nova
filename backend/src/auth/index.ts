import type { AuthProvider } from "./base.ts"
import { DemoAuthProvider } from "./demo.ts"
import { EntraAuthProvider } from "./entra.ts"
import type { Jwk } from "./entraToken.ts"
import type { Database } from "../db/index.ts"
import { getConfig } from "../config/index.ts"

/**
 * Provider selection is driven ONLY by explicit configuration.
 *
 *   AUTH_MODE=demo   -> DemoAuthProvider  (local/demo persona switching)
 *   AUTH_MODE=entra  -> EntraAuthProvider (Microsoft Entra ID + Neon mapping)
 *
 * The presence of Entra environment variables never switches authentication
 * on by itself, and Entra mode never falls back to demo authentication:
 * incomplete configuration fails in getConfig() before this runs.
 */
export function createAuthProvider(db: Database, keyLoader?: () => Promise<Jwk[]>): AuthProvider {
	const config = getConfig()
	if (config.modes.authMode === "entra") {
		return new EntraAuthProvider(db, config.entra, keyLoader)
	}
	return new DemoAuthProvider(db, config.demoAuth.sessionSecret)
}

export type { AuthProvider } from "./base.ts"
export { AuthError } from "./base.ts"
export { EntraAuthProvider } from "./entra.ts"
export { DemoAuthProvider } from "./demo.ts"
