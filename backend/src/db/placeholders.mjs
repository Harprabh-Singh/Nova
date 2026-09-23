/**
 * Converts SQLite-style `?` placeholders to PostgreSQL `$n`, skipping quoted
 * strings/identifiers and `--` comments so literal question marks are untouched.
 * Values are always bound as parameters; nothing is interpolated into SQL.
 * @param {string} sql
 * @returns {string}
 */
export function toPostgresPlaceholders(sql) {
	let out = ""
	let n = 0
	let i = 0
	while (i < sql.length) {
		const c = sql[i]
		if (c === "'" || c === '"') {
			let j = i + 1
			while (j < sql.length) {
				if (sql[j] === c) {
					if (sql[j + 1] === c) {
						j += 2
						continue
					}
					break
				}
				j++
			}
			out += sql.slice(i, j + 1)
			i = j + 1
			continue
		}
		if (c === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i)
			const stop = end < 0 ? sql.length : end
			out += sql.slice(i, stop)
			i = stop
			continue
		}
		if (c === "?") {
			out += `$${++n}`
			i++
			continue
		}
		out += c
		i++
	}
	return out
}
