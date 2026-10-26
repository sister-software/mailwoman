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

import { type DuckDBLimits, escapeSQLIdentifier, escapeSQLString, openDuckDB } from "#parquet/duckdb"

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
	// The raw value makes `row.address_levels[0].value` read `undefined` on every row.
	// A consumer counting values then reports that the file does not populate the column.
	// Overture's `address_levels` and `sources` are both lists of structs.
	// Unwrapped values made the audit report all 25,914,431 Italian rows as lacking locality.
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
	 * A column absent from the file raises rather than coming back absent: a projection that
	 * silently drops a field hands the consumer a well-formed row with the field missing.
	 * The consumer reads that as "this row has no value there" instead of "this file has no such column".
	 */
	columns?: readonly string[]
	/**
	 * Stop after this number of rows.
	 */
	limit?: number
	/**
	 * A DuckDB boolean expression rows must satisfy, interpolated as the `WHERE` clause.
	 *
	 * The caller builds it, escaping every literal with `escapeSQLString`.
	 */
	where?: string
	/**
	 * A DuckDB `ORDER BY` expression, interpolated as written.
	 *
	 * Without one, rows arrive in file order.
	 */
	orderBy?: string
	/**
	 * The memory and thread limits of the connection the stream opens.
	 *
	 * @defaultValue {@linkcode openDuckDB}'s defaults
	 */
	limits?: DuckDBLimits
}

/**
 * The `read_parquet` call over one local parquet file or several, read as one table.
 */
export function readParquetSQL(path: PathBuilderLike | readonly PathBuilderLike[]): string {
	const paths = (Array.isArray(path) ? path : [path]).map((each) => `'${escapeSQLString(each.toString())}'`)

	return `read_parquet([${paths.join(", ")}])`
}

/**
 * Open a row stream over one local parquet file or several, yielding rows in DuckDB-managed chunks.
 *
 * DuckDB opens the paths itself and exposes its DataChunks through `fetchChunk()`.
 * Rows are converted and yielded one chunk at a time, so neither the complete Parquet file
 * nor the complete result set is copied into JavaScript memory.
 */
export async function* openParquetRowStream<T>(
	path: PathBuilderLike | readonly PathBuilderLike[],
	options: ParquetRowStreamOptions = {}
): AsyncGenerator<T> {
	const { columns, limit, where, orderBy, limits } = options
	// Disposed when this generator finishes or a consumer abandons it,
	// since `for await` calls `.return()` on break.
	using db = await openDuckDB(limits)
	const projection = columns?.length ? columns.map(escapeSQLIdentifier).join(", ") : "*"
	const limitClause = typeof limit !== "number" ? "" : ` LIMIT ${validateRowLimit(limit)}`
	const whereClause = where ? ` WHERE ${where}` : ""
	const orderClause = orderBy ? ` ORDER BY ${orderBy}` : ""
	const sql = `SELECT ${projection} FROM ${readParquetSQL(path)}${whereClause}${orderClause}${limitClause}`

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
