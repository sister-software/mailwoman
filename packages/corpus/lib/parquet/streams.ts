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

import { connectDuckDB, escapeSQLIdentifier, escapeSQLString } from "#parquet/duckdb"

/**
 * DuckDB hands a list column back as `{ items: [...] }`.
 *
 * Unwrap it so a row reads the way the schema declares it, recursively,
 * because a nested list arrives nested the same way.
 */
function normalizeDuckDBValue(value: unknown): unknown {
	if (value && typeof value === "object" && "items" in value && Array.isArray(value.items)) {
		return value.items.map(normalizeDuckDBValue)
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
	const db = await connectDuckDB()
	const projection = columns?.length ? columns.map(escapeSQLIdentifier).join(", ") : "*"
	const limitClause = limit === undefined ? "" : ` LIMIT ${validateRowLimit(limit)}`
	const sql = `SELECT ${projection} FROM read_parquet('${escapeSQLString(String(path))}')${limitClause}`

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
	} finally {
		db.closeSync()
	}
}
