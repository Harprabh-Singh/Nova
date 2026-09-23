/**
 * Clears all local demo state (database + uploaded document storage) and
 * re-seeds the initial environment. Local mode only, by design.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import { getConfig, loadEnv } from "../src/config/index.ts"

loadEnv()
const config = getConfig()

if (!config.isFullyLocal) {
	console.error("reset-demo only runs in local mode. Set AI_MODE/KNOWLEDGE_MODE/AUTH_MODE back to local first.")
	process.exit(1)
}

if (config.modes.storageMode !== "local") {
	console.error("reset-demo only clears local document storage. It never deletes objects from Azure Blob Storage.")
	process.exit(1)
}

if (config.database.kind !== "sqlite") {
	console.error("reset-demo only resets the local SQLite demo database. It never deletes data from a PostgreSQL DATABASE_URL.")
	process.exit(1)
}

for (const target of [config.paths.dbFile, `${config.paths.dbFile}-wal`, `${config.paths.dbFile}-shm`]) {
	if (fs.existsSync(target)) {
		fs.rmSync(target)
		console.log(`removed ${path.relative(process.cwd(), target)}`)
	}
}

if (fs.existsSync(config.paths.storageDir)) {
	fs.rmSync(config.paths.storageDir, { recursive: true, force: true })
	console.log(`removed ${path.relative(process.cwd(), config.paths.storageDir)}`)
}

const seed = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(path.dirname(fileURLToPath(import.meta.url)), "seed-demo.ts")], {
	stdio: "inherit",
})
process.exit(seed.status ?? 0)
