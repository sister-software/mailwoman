/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The DuckDB boundary for the parquet family — the one place that opens a connection, and the two escapers every
 *   statement built here goes through.
 *
 *   `@duckdb/node-api` is an optional peer, so the import is lazy: the native module loads only on the paths that read
 *   or write Parquet through DuckDB, and a consumer that only needs the schema types never pays for it.
 */

/**
 * An open DuckDB connection, re-exported so consumers of {@link connectDuckDB} can
 * name the type without their own static dependency on the optional peer.
 */
export type { DuckDBConnection } from "@duckdb/node-api"

/**
 * Open an in-memory DuckDB connection.
 *
 * The caller owns the close. Every reader and writer in this family wraps its use
 * in `try`/`finally` with `db.closeSync()`, because a connection left open holds
 * the native instance for the life of the process.
 */
export async function connectDuckDB(): Promise<import("@duckdb/node-api").DuckDBConnection> {
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()

	return await instance.connect()
}

/**
 * Escape `value` for a single-quoted SQL string literal.
 * The caller supplies the quotes.
 */
export function escapeSQLString(value: string): string {
	return value.replaceAll("'", "''")
}

/**
 * Escape `value` as a double-quoted SQL identifier, for a column name that reaches a statement from data.
 *
 * A projection names columns the caller chose, so the name is not a literal this
 * module wrote. Quoting it keeps a column whose name collides with a keyword —
 * or carries a space — from re-parsing as syntax.
 */
export function escapeSQLIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}
