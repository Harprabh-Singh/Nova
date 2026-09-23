/**
 * Document storage management commands.
 *
 *   npm run storage:status     configuration summary (no remote call)
 *   npm run storage:validate   REAL connectivity check: container + write/read/delete
 *   npm run storage:init       create the container if it does not exist (private)
 *
 * These are DELIBERATE administrative diagnostics, which is why they may talk to
 * Azure. `/api/health` and `/api/admin/metrics` must never do any of this: they
 * stay local, synchronous and free of remote storage calls.
 *
 * Nothing here ever prints the connection string or the account key.
 */
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"

import { getConfig, loadEnv } from "../src/config/index.ts"
import { createAzureBlobStorageProvider, createStorageProvider } from "../src/storage/index.ts"
import { StorageError } from "../src/storage/base.ts"
import type { StorageProvider } from "../src/storage/base.ts"

type Command = "status" | "validate" | "init"

function line(label: string, value: string): void {
	console.log(`  ${label.padEnd(24)} ${value}`)
}

function statusReport(provider: StorageProvider): void {
	const config = getConfig()
	console.log("\nNOVA document storage\n")
	line("STORAGE_MODE", config.modes.storageMode)
	line("provider", provider.name)
	line("location", provider.describe())
	line("max document size", `${Math.round(getConfig().documents.maxBytes / 1024 / 1024)} MB`)
	if (config.modes.storageMode === "azure_blob") {
		line("account", config.azure?.storage.account || "(from connection string)")
		line("container", config.azure?.storage.container ?? "")
		// Presence only: the value is never printed.
		line("connection string", config.azure?.storage.connectionString ? "present" : "MISSING")
	} else {
		line("storage root", config.paths.storageDir)
	}
	console.log("\n  key template            tenant/<tenantId>/document/<documentId>/version/<versionId>/original.<ext>\n")
}

/**
 * Real round trip against the configured container. The temporary object lives
 * under a dedicated diagnostics prefix and is always removed again, so the
 * production `documents` container is never left with test files.
 */
async function validate(): Promise<number> {
	const config = getConfig()
	const provider = createStorageProvider()
	statusReport(provider)

	if (config.modes.storageMode !== "azure_blob") {
		console.log("  STORAGE_MODE=local: validating the local filesystem provider.\n")
	}

	const key = `diagnostics/storage-validate/${randomUUID()}/original.txt`
	const payload = Buffer.from(`nova storage validation ${new Date().toISOString()}\n`, "utf8")
	let failures = 0

	try {
		if (config.modes.storageMode === "azure_blob") {
			const azure = createAzureBlobStorageProvider()
			const container = await azure.blobClient.getContainerProperties()
			if (!container) {
				console.error(`  FAIL  container "${azure.container}" does not exist. Run: npm run storage:init`)
				return 1
			}
			console.log(`  PASS  container "${azure.container}" exists`)
			const publicAccess = container.publicAccess
			if (publicAccess && publicAccess !== "false") {
				console.error(`  FAIL  container allows anonymous access ("${publicAccess}"). It must stay private.`)
				failures += 1
			} else {
				console.log("  PASS  container is private (no anonymous access)")
			}
		}

		await provider.put(key, payload, { contentType: "text/plain; charset=utf-8", metadata: { purpose: "validation" } })
		console.log("  PASS  write")

		const readBack = await provider.get(key)
		if (!readBack.equals(payload)) {
			console.error("  FAIL  read back did not match what was written")
			failures += 1
		} else {
			console.log("  PASS  read + content match")
		}

		const head = await provider.head(key)
		if (!head) {
			console.error("  FAIL  metadata lookup returned nothing")
			failures += 1
		} else {
			console.log(`  PASS  metadata (${head.size} bytes, ${head.contentType})`)
		}

		if (!(await provider.exists(key))) {
			console.error("  FAIL  exists() returned false for an object that was just written")
			failures += 1
		} else {
			console.log("  PASS  exists")
		}
	} catch (error) {
		console.error(`  FAIL  ${error instanceof StorageError ? error.diagnostic : (error as Error).message}`)
		failures += 1
	} finally {
		// Always clean up, including after a partial failure.
		try {
			await provider.delete(key)
			const gone = !(await provider.exists(key))
			console.log(gone ? "  PASS  delete + cleanup verified" : "  FAIL  the temporary object still exists after delete")
			if (!gone) failures += 1
		} catch (error) {
			console.error(`  FAIL  cleanup: ${error instanceof StorageError ? error.diagnostic : (error as Error).message}`)
			failures += 1
		}
	}

	console.log(failures === 0 ? "\nSTORAGE VALIDATION: PASS\n" : `\nSTORAGE VALIDATION: FAIL (${failures})\n`)
	return failures === 0 ? 0 : 1
}

/** Explicit setup. Normal application requests never create the container. */
async function init(): Promise<number> {
	const config = getConfig()
	if (config.modes.storageMode !== "azure_blob") {
		console.error("storage:init only applies to STORAGE_MODE=azure_blob. Local storage directories are created on demand.")
		return 1
	}
	const azure = createAzureBlobStorageProvider()
	const result = await azure.blobClient.createContainer()
	console.log(
		result === "created"
			? `Created private container "${azure.container}".`
			: `Container "${azure.container}" already exists; reusing it.`,
	)
	const properties = await azure.blobClient.getContainerProperties()
	const publicAccess = properties?.publicAccess
	if (publicAccess && publicAccess !== "false") {
		console.error(`WARNING: container "${azure.container}" allows anonymous access ("${publicAccess}"). Disable it.`)
		return 1
	}
	console.log("Anonymous access: disabled.")
	return 0
}

export async function runStorageCommand(command: Command): Promise<number> {
	switch (command) {
		case "status":
			statusReport(createStorageProvider())
			return 0
		case "validate":
			return validate()
		case "init":
			return init()
		default:
			console.error(`Unknown storage command "${command}". Use status | validate | init.`)
			return 1
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	loadEnv()
	const command = (process.argv[2] ?? "status") as Command
	runStorageCommand(command)
		.then((code) => process.exit(code))
		.catch((error) => {
			// StorageError.diagnostic is already scrubbed; nothing else is printed.
			console.error(error instanceof StorageError ? error.diagnostic : String((error as Error)?.message ?? error))
			process.exit(1)
		})
}
