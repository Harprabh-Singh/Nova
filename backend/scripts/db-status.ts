/** npm run db:status — show applied / pending migrations for the PostgreSQL DATABASE_URL. Exits 1 if anything is pending or modified. */
import pg from "pg"
import { getConfig, loadEnv } from "../src/config/index.ts"
import { migrationStatus } from "../src/db/migrate.ts"

loadEnv()
const config = getConfig()
if (config.database.kind !== "postgres") {
	console.error("db:status requires DATABASE_URL to be a PostgreSQL connection string (production/Azure mode).")
	process.exit(1)
}
const pool = new pg.Pool({ connectionString: config.database.url, max: 1, application_name: "nova-migrations" })
try {
	const states = await migrationStatus(pool)
	for (const s of states) console.log(`${s.status.padEnd(8)} ${s.file}${s.appliedAt ? `  (${s.appliedAt})` : ""}`)
	const outstanding = states.filter((s) => s.status !== "applied")
	console.log(outstanding.length ? `${outstanding.length} migration(s) need attention` : "database is up to date")
	if (outstanding.length) process.exitCode = 1
} catch (error) {
	console.error(`db:status failed: ${(error as Error).message}`)
	process.exitCode = 1
} finally {
	await pool.end()
}
