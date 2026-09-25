/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pull-based parquet reading, the same split `@mailwoman/core/fs` draws between `/readers` and `/streams`.
 *
 *   A stream returns immediately and the work happens as the consumer pulls, so a caller can walk a file larger than
 *   memory. A caller that wants the rows, or only their count, uses `./readers` instead and awaits a value.
 */

import type { PathBuilderLike } from "path-ts"

import { escapeSQLIdentifier, escapeSQLString, openDuckDB } from "#parquet/duckdb"

/**
 * DuckDB hands a list column back as `{ items: [...] }`.
 *
 * Unwrap it so a row reads the way the schema declares it, recursively,
 * because a nested list arrives nested the same way.
 */
export function normalizeDuckDBValue(value: unknown): unknown {
	if (value && typeof value === "object" && "items" in value && Array.isArray(value.items)) {
		return value.items.map(normalizeDuckDBValue)
	}

	// A DuckDB STRUCT arrives as `{ entries: { field: value } }` rather than as
	// the plain object its fields describe.
	// Handing that through makes `row.address_levels[0].value` read `undefined` on every row,
	// which a consumer counting values reports as a column the file does not populate.
	// Overture's `address_levels` and `sources` are both lists of structs, and reading
	// them unwrapped reported all 25,914,431 Italian rows as carrying no locality.
	if (value && typeof value === "object" && "entries" in value && value.entries && typeof value.entries === "object") {
		return Object.fromEntries(
			Object.entries(value.entries as Record<string, unknown>).map(([key, entry]) => [key, normalizeDuckDBValue(entry)])
		)
	}

	if (Array.isArray(value)) return value.map(normalizeDuckDBValue)

	return value
}

/**
 * A row limit has to be a non-negative safe integer before it reaches a `limit` clause,
 * because it is interpolated rather than bound.
 */
export function validateRowLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`Parquet row limit must be a non-negative integer: ${value}`)

	return value
}

export interface ParquetRowStreamOptions {
	/**
	 * Columns to project.
	 *
	 * Every column when omitted.
	 *
	 * A column the file does not carry raises rather than coming back absent: a projection
	 * that silently drops a field hands the consumer a well-formed row with the field missing,
	 * which reads as "this row has no value there" rather than "this file has no such column".
	 */
	columns?: readonly string[]
	/**
	 * Stop after this many rows.
	 */
	limit?: number
}

/**
 * Open a row stream over a local parquet file, yielding rows in DuckDB-managed chunks.
 *
 * DuckDB opens the path itself and exposes its DataChunks through `fetchChunk()`.
 * Rows are converted and yielded one chunk at a time, so neither the complete Parquet file
 * nor the complete result set is copied into JavaScript memory.
 */
export async function* openParquetRowStream<T>(
	path: PathBuilderLike,
	options: ParquetRowStreamOptions = {}
): AsyncGenerator<T> {
	const { columns, limit } = options
	// Disposed when this generator finishes or a consumer abandons it,
	// since `for await` calls `.return()` on break.
	using db = await openDuckDB()
	const projection = columns?.length ? columns.map(escapeSQLIdentifier).join(", ") : "*"
	const limitClause = limit === undefined ? "" : ` LIMIT ${validateRowLimit(limit)}`
	const sql = `SELECT ${projection} FROM read_parquet('${escapeSQLString(path.toString())}')${limitClause}`

	try {
		const stream = await db.stream(sql)
		const columnNames = stream.columnNames()

		for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
			const rows = chunk.getRowObjects(columnNames) as Record<string, unknown>[]

			for (const row of rows) {
				yield Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeDuckDBValue(value)])) as T
			}
		}
	} catch (error) {
		if (columns && /Binder Error|Referenced column|does not exist/.test(String(error))) {
			const missing =
				String(error).match(/(?:Referenced column|field named) ["']([^"']+)["']/)?.[1] ?? columns.join(", ")

			throw new Error(`Parquet projection requested column absent from the file schema: ${missing}`, {
				cause: error,
			})
		}

		throw error
	}
}
