/** npm run db:migrate — apply pending versioned migrations to the PostgreSQL DATABASE_URL (Neon). */
import pg from "pg"
import { getConfig, loadEnv } from "../src/config/index.ts"
import { runMigrations } from "../src/db/migrate.ts"

loadEnv()
const config = getConfig()
if (config.database.kind !== "postgres") {
	console.error("db:migrate requires DATABASE_URL to be a PostgreSQL connection string (production/Azure mode). Local/demo SQLite needs no migrations.")
	process.exit(1)
}
const pool = new pg.Pool({ connectionString: config.database.url, max: 1, application_name: "nova-migrations" })
try {
	const result = await runMigrations(pool, { log: (line) => console.log(line) })
	console.log(`done: ${result.applied.length} applied, ${result.skipped.length} already applied`)
} catch (error) {
	console.error(`db:migrate failed: ${(error as Error).message}`)
	process.exitCode = 1
} finally {
	await pool.end()
}
