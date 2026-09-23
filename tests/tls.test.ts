/**
 * TLS suite.
 *
 * NOVA serves plain HTTP by default — `localhost` is already a secure context
 * in browsers, and real deployments terminate TLS in front of the process.
 * These tests pin that default and the rules for the opt-in path: HTTPS must
 * be given a real certificate, and it never silently downgrades to HTTP.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { ConfigError, getConfig, resetConfigCache } from "../backend/src/config/index.ts"
import { TlsError, browserHost, isLoopbackHost, resolveTlsMaterial, serverScheme } from "../backend/src/api/tls.ts"

const TLS_KEYS = ["HTTPS_ENABLED", "TLS_CERT_FILE", "TLS_KEY_FILE", "HOST", "PORT"] as const

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
	const previous = new Map<string, string | undefined>()
	for (const key of TLS_KEYS) previous.set(key, process.env[key])
	for (const key of TLS_KEYS) delete process.env[key]
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	resetConfigCache()
	try {
		run()
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		resetConfigCache()
	}
}

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "nova-tls-"))
}

test("plain HTTP is the default and no certificate is required", () => {
	withEnv({}, () => {
		const config = getConfig()
		assert.equal(config.server.https, false)
		assert.equal(serverScheme(config), "http")
		assert.equal(resolveTlsMaterial(config), null)
	})
})

test("a non-boolean HTTPS_ENABLED is refused rather than guessed", () => {
	withEnv({ HTTPS_ENABLED: "yes please" }, () => {
		assert.throws(() => getConfig(), ConfigError)
	})
})

test("loopback hosts are recognised and reported as localhost", () => {
	for (const host of ["localhost", "127.0.0.1", "::1", "0.0.0.0"]) assert.equal(isLoopbackHost(host), true)
	assert.equal(isLoopbackHost("nova.example.com"), false)
	for (const host of ["127.0.0.1", "::1", "0.0.0.0", ""]) assert.equal(browserHost(host), "localhost")
	assert.equal(browserHost("nova.example.com"), "nova.example.com")
})

test("HTTPS without a certificate fails loudly instead of downgrading", () => {
	withEnv({ HTTPS_ENABLED: "true" }, () => {
		assert.throws(() => resolveTlsMaterial(getConfig()), TlsError)
	})
})

test("HTTPS with an unreadable certificate fails loudly", () => {
	withEnv(
		{ HTTPS_ENABLED: "true", TLS_CERT_FILE: "/nope/cert.pem", TLS_KEY_FILE: "/nope/key.pem" },
		() => {
			assert.throws(() => resolveTlsMaterial(getConfig()), TlsError)
		},
	)
})

test("an existing certificate and key are used as supplied", () => {
	const dir = tempDir()
	const certFile = path.join(dir, "cert.pem")
	const keyFile = path.join(dir, "key.pem")
	fs.writeFileSync(certFile, "CERT-BYTES")
	fs.writeFileSync(keyFile, "KEY-BYTES")

	withEnv({ HTTPS_ENABLED: "true", TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile }, () => {
		const config = getConfig()
		assert.equal(serverScheme(config), "https")
		const material = resolveTlsMaterial(config)
		assert.equal(material?.cert.toString("utf8"), "CERT-BYTES")
		assert.equal(material?.key.toString("utf8"), "KEY-BYTES")
	})
})
