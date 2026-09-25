/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Shared helpers for the SQLite-backed lookups.
 */

import { allRows, getRow } from "@mailwoman/core/utils"
import type { DatabaseClient, SQLInputValue } from "@mailwoman/sqlite/client"
import { hasColumn as columnExists, tableExists } from "@mailwoman/sqlite/introspection"

/**
 * A prepared single-row query whose parameter tuple stays visible to TypeScript.
 *
 * `StatementSync` accepts any `SQLInputValue[]`, which would erase tagged key types at the call site.
 */
export type PreparedGet<Parameters extends SQLInputValue[], Row> = (...parameters: Parameters) => Row | undefined

/**
 * Prepares a single-row query with a typed parameter tuple.
 */
export function prepareGet<Parameters extends SQLInputValue[], Row, DB>(
	db: DatabaseClient<DB>,
	sql: string
): PreparedGet<Parameters, Row> {
	const statement = db.prepare(sql)

	return (...parameters) => getRow<Row>(statement, ...parameters)
}

/**
 * The multi-row counterpart to {@link PreparedGet}.
 */
export type PreparedAll<Parameters extends SQLInputValue[], Row> = (...parameters: Parameters) => Row[]

/**
 * Prepares a multi-row query with a typed parameter tuple.
 */
export function prepareAll<Parameters extends SQLInputValue[], Row, DB>(
	db: DatabaseClient<DB>,
	sql: string
): PreparedAll<Parameters, Row> {
	const statement = db.prepare(sql)

	return (...parameters) => allRows<Row>(statement, ...parameters)
}

/**
 * Returns true when `name` is a table in the open database, and false when the check itself fails.
 *
 * The street-level lookups call it so that an empty extract, such as an interrupted build
 * or a zero-byte file, makes every lookup miss instead of throwing `no such table`.
 */
export function hasTable<DB>(db: DatabaseClient<DB>, name: string): boolean {
	try {
		return tableExists(db, name)
	} catch {
		return false
	}
}

/**
 * Returns true when `table` exists in the open database and has `column`.
 *
 * An artifact built before a column was added is still valid, so readers call this once
 * at construction and leave the column out of their queries when it is missing.
 * Avoid calling it per query, because it runs a pragma.
 *
 * The pragma does not accept bound parameters, so `table` is interpolated into the SQL.
 * Pass only constants.
 */
export function hasColumn<DB>(db: DatabaseClient<DB>, table: string, column: string): boolean {
	try {
		return columnExists(db, table, column)
	} catch {
		return false
	}
}
