/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Small shared helpers for the SQLite-backed lookups.
 */

import { allRows, getRow } from "@mailwoman/core/utils"
import type { DatabaseClient, SQLInputValue } from "@mailwoman/sqlite/client"
import { hasColumn as columnExists, tableExists } from "@mailwoman/sqlite/introspection"

// The row-shape assertion itself lives in `core` so the readers that cannot depend on this package reach the same
// seam; re-exported here because this module is where this package's readers already look for it.
export { allRows, getRow } from "@mailwoman/core/utils"

/**
 * A prepared single-row query whose parameter tuple remains visible to TypeScript. `StatementSync` accepts only the
 * broad `SQLInputValue[]`, which otherwise erases tagged key types before they reach SQLite.
 */
export type PreparedGet<Parameters extends SQLInputValue[], Row> = (...parameters: Parameters) => Row | undefined

/**
 * Prepare a single-row query while preserving its exact parameter tuple at every call site.
 */
export function prepareGet<Parameters extends SQLInputValue[], Row, DB>(
	db: DatabaseClient<DB>,
	sql: string
): PreparedGet<Parameters, Row> {
	const statement = db.prepare(sql)

	return (...parameters) => getRow<Row>(statement, ...parameters)
}

/**
 * Multi-row counterpart to {@link PreparedGet}.
 */
export type PreparedAll<Parameters extends SQLInputValue[], Row> = (...parameters: Parameters) => Row[]

/**
 * Prepare a multi-row query while preserving its exact parameter tuple at every call site.
 */
export function prepareAll<Parameters extends SQLInputValue[], Row, DB>(
	db: DatabaseClient<DB>,
	sql: string
): PreparedAll<Parameters, Row> {
	const statement = db.prepare(sql)

	return (...parameters) => allRows<Row>(statement, ...parameters)
}

/**
 * True when `name` is a table in the open database. The street-level lookups use this to degrade gracefully on an
 * empty/tableless shard — an interrupted `build-*-shard.ts`, or a stray 0-byte file (e.g. `sqlite3 <missing>.db "…"`
 * CREATES one) — rather than throwing `no such table` at construction and taking down a whole state's geocode (#568). A
 * missing table makes the lookup a no-op miss.
 */
export function hasTable<DB>(db: DatabaseClient<DB>, name: string): boolean {
	try {
		return tableExists(db, name)
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
export function hasColumn<DB>(db: DatabaseClient<DB>, table: string, column: string): boolean {
	try {
		return columnExists(db, table, column)
	} catch {
		return false
	}
}
