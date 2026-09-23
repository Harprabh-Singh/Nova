/** NOVA entrypoint. */
import { getConfig, loadEnv } from "./config/index.ts"
import { createServer, createServices } from "./api/server.ts"
import { browserHost, serverScheme } from "./api/tls.ts"
import { log } from "./observability/logger.ts"
import { listTenants } from "./tenants/service.ts"
import { closeDb } from "./db/index.ts"

loadEnv()
const config = getConfig()
/**
 * Startup order: configuration (validates DATABASE_URL; no SQLite fallback in
 * production/Azure mode) -> database (SQLite locally, Neon PostgreSQL in
 * production, which must already be migrated) -> services -> HTTP server.
 */
let services: ReturnType<typeof createServices>
try {
	services = createServices()
} catch (error) {
	log.error("server.database_unavailable", { database: config.database.kind, error: (error as Error).message })
	console.error(`\n  NOVA could not start: ${(error as Error).message}\n`)
	process.exit(1)
}
/**
 * The server is plain HTTP unless HTTPS_ENABLED=true, in which case an
 * unreadable certificate is a startup failure, never a silent downgrade.
 */
let server: ReturnType<typeof createServer>
try {
	server = createServer(services)
} catch (error) {
	log.error("server.tls_unavailable", { error: (error as Error).message })
	console.error(`\n  NOVA could not start: ${(error as Error).message}\n`)
	process.exit(1)
}

/**
 * Bind to the configured port, automatically trying the next ports when it's
 * busy (EADDRINUSE) — a stale dev server should never block a fresh start.
 *
 * EXCEPTION (Phase 6): with AUTH_MODE=entra the browser origin must be the
 * exact redirect URI registered on the Entra application. Silently binding a
 * different, unregistered port would break sign-in in a way that looks like
 * an Entra problem, so Entra mode fails clearly instead.
 */
const MAX_PORT_ATTEMPTS = 100
let attempt = 0

function tryListen(port: number): void {
	server.once("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE" && !config.server.allowPortFallback) {
			log.error("server.auth_port_busy", { port, authMode: config.modes.authMode })
			console.error(
				`\n  NOVA could not start: AUTH_MODE=entra requires the registered redirect origin ` +
					`${config.entra.redirectUri} (port ${port}), but that port is already in use.\n` +
					"  Free the port, or register and configure a different ENTRA_REDIRECT_URI.\n",
			)
			process.exit(1)
		}
		if (error.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
			attempt += 1
			log.warn("server.port_busy", { port, trying: port + 1 })
			tryListen(port + 1)
			return
		}
		throw error
	})
	server.listen(port, config.server.host, () => {
		const tenants = listTenants(services.db)
		log.info("server.started", {
			url: `${serverScheme(config)}://${browserHost(config.server.host)}:${port}`,
			mode: config.isFullyLocal ? "LOCAL DEMO MODE" : "AZURE MODE",
			modes: config.modes,
			llm: services.providers.llm.model,
			embeddings: services.providers.embeddings.model,
			tenants: tenants.length,
			// Safe descriptor: provider + container/root, never a credential.
			storage: services.providers.storage.describe(),
			...(attempt > 0 ? { note: `configured port was busy, bound to ${port} instead` } : {}),
		})
		if (attempt > 0) {
			console.log(
				`\n  ⚠ Port ${config.server.port} was busy — NOVA is running at ${serverScheme(config)}://${browserHost(config.server.host)}:${port} instead\n`,
			)
		}
		console.log(`\n  NOVA is running at ${serverScheme(config)}://${browserHost(config.server.host)}:${port}\n`)
		if (tenants.length === 0) log.warn("server.no_tenants", { hint: "Run: npm run seed-demo" })
		// Azure elsewhere but documents still on local disk is legal (it is an
		// explicit choice) but it is never silent: files written here do not
		// survive a container restart.
		if (!config.isFullyLocal && config.modes.storageMode === "local") {
			log.warn("server.local_document_storage", {
				hint: "Azure providers are enabled but STORAGE_MODE=local: document files stay on this machine's disk. Set STORAGE_MODE=azure_blob for durable storage.",
			})
		}
	})
}

tryListen(config.server.port)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		log.info("server.stopping", { signal })
		server.close(() => {
			closeDb()
			process.exit(0)
		})
	})
}
