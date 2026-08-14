/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Small shared helpers for the SQLite-backed lookups.
 */

import type { DatabaseSync } from "node:sqlite"

/**
 * True when `name` is a table in the open database. The street-level lookups use this to degrade gracefully on an
 * empty/tableless shard — an interrupted `build-*-shard.ts`, or a stray 0-byte file (e.g. `sqlite3 <missing>.db "…"`
 * CREATES one) — rather than throwing `no such table` at construction and taking down a whole state's geocode (#568). A
 * missing table makes the lookup a no-op miss.
 */
export function hasTable(db: DatabaseSync, name: string): boolean {
	try {
		const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name)

		return row !== undefined
	} catch {
		return false
	}
}

/**
 * True when `table` exists in the open database AND carries `column`.
 *
 * The column-level sibling of {@link hasTable}, and it exists for the same reason one layer down: an artifact built
 * before a column was added is still a VALID artifact, and a reader that unconditionally names the new column in its
 * `SELECT` turns "this gazetteer is a build behind" into `no such column` at the first keystroke. Probe once at
 * construction and shape the query — `table_info` is a PRAGMA, so it must not sit on a per-query path.
 *
 * Note the interpolation: PRAGMA does not take bound parameters, so `table` is spliced. Every caller passes a
 * module-level constant; never pass user input.
 */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>

		return rows.some((r) => String(r.name) === column)
	} catch {
		return false
	}
}
