/**
 * TLS for the NOVA server.
 *
 * Local development runs over plain HTTP: browsers already treat `localhost`
 * as a secure context, so TLS buys nothing there but costs certificate
 * warnings and setup. HTTPS is therefore opt-in.
 *
 * In a real deployment TLS is normally terminated in front of NOVA (Azure App
 * Service, a load balancer, a reverse proxy), which is the default assumption.
 * If NOVA must terminate TLS itself, set HTTPS_ENABLED=true and point
 * TLS_CERT_FILE / TLS_KEY_FILE at a real certificate and key.
 *
 * NOVA never invents a certificate and never silently downgrades: if HTTPS is
 * requested and the material cannot be read, startup fails with a clear
 * message. The private key is read into memory and never logged.
 */
import fs from "node:fs"
import path from "node:path"

import { getConfig } from "../config/index.ts"

export class TlsError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TlsError"
	}
}

/** True for addresses that only accept connections from this machine. */
export function isLoopbackHost(host: string): boolean {
	const value = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
	return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "0.0.0.0"
}

/**
 * The hostname to print in logs and startup messages. A wildcard or loopback
 * bind address is shown as `localhost`, which is what a browser should use.
 */
export function browserHost(host: string): string {
	const value = String(host ?? "").trim()
	if (value === "" || value === "0.0.0.0" || value === "::" || value === "127.0.0.1" || value === "::1") return "localhost"
	return value
}

export type TlsMaterial = { key: Buffer; cert: Buffer; certFile: string; keyFile: string }

/**
 * Resolves the TLS material for this process, or null when HTTPS is off
 * (the default). Throws a TlsError - never falls back to HTTP - when HTTPS is
 * requested but the certificate or key cannot be read.
 */
export function resolveTlsMaterial(config = getConfig()): TlsMaterial | null {
	const { https, tls } = config.server
	if (!https) return null

	if (!tls.certFile || !tls.keyFile) {
		throw new TlsError(
			"HTTPS_ENABLED=true requires TLS_CERT_FILE and TLS_KEY_FILE to point at a certificate and key. " +
				"Set HTTPS_ENABLED=false to serve plain HTTP (the default, and what a TLS-terminating proxy expects).",
		)
	}

	const certFile = path.resolve(tls.certFile)
	const keyFile = path.resolve(tls.keyFile)
	try {
		return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), certFile, keyFile }
	} catch (error) {
		throw new TlsError(
			`The HTTPS certificate or key could not be read (${(error as Error).message}). ` +
				"Check TLS_CERT_FILE and TLS_KEY_FILE.",
		)
	}
}

/** Scheme for logs and printed URLs. Never guesses: it follows the real server. */
export function serverScheme(config = getConfig()): "http" | "https" {
	return config.server.https ? "https" : "http"
}
