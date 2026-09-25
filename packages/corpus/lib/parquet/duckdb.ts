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
 * An open DuckDB connection, re-exported so consumers of {@link openDuckDB} can name
 * the type without their own static dependency on the optional peer.
 */
export type { DuckDBConnection } from "@duckdb/node-api"

/**
 * An in-memory DuckDB connection whose disposal also closes the instance behind it.
 *
 * Both closes are synchronous, so this is `Disposable` rather than `AsyncDisposable`,
 * the same as {@link DatabaseClient}.
 */
export type DisposableDuckDB = import("@duckdb/node-api").DuckDBConnection & Disposable

/**
 * Open an in-memory DuckDB connection, taken with `using db = await openDuckDB()`.
 *
 * The connection is returned directly, so it reads as a connection at every call site.
 * Disposal closes it and then the instance: a connection left open holds the native instance
 * for the life of the process, and one opened per file in a loop holds one per file.
 */
export async function openDuckDB(): Promise<DisposableDuckDB> {
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const connection = await instance.connect()

	return Object.assign(connection, {
		[Symbol.dispose]: () => {
			connection.closeSync()
			instance.closeSync()
		},
	})
}

/**
 * Escape `value` for a single-quoted SQL string literal.
 *
 * The caller supplies the quotes.
 */
export function escapeSQLString(value: string): string {
	return value.replaceAll("'", "''")
}

/**
 * Escape `value` as a double-quoted SQL identifier, for a column name that reaches a statement from data.
 *
 * A projection names columns the caller chose, so the name is not a literal this module wrote.
 * Quoting it keeps a column whose name collides with a keyword — or carries a space —
 * from re-parsing as syntax.
 */
export function escapeSQLIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}
