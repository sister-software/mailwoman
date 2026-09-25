/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Promise-based parquet reads. The iterator-based reads live in `./streams`.
 *
 *   {@linkcode readParquetRows} throws when the file is missing, and {@linkcode tryReadParquetRows} returns `null`.
 *   Both throw for an unreadable file, so a caller cannot mistake a read failure for an empty file.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import { connectDuckDB, escapeSQLString } from "#parquet/duckdb"
import { openParquetRowStream, type ParquetRowStreamOptions } from "#parquet/streams"

/**
 * Reads every row of a parquet file into memory.
 *
 * Use {@linkcode openParquetRowStream} for a file too large to hold in memory.
 *
 * @throws When the file is missing or `columns` includes a column the file lacks.
 */
export async function readParquetRows<T>(path: PathBuilderLike, options: ParquetRowStreamOptions = {}): Promise<T[]> {
	if (!(await pathExists(path))) {
		throw new Error(`No parquet file at ${path}`)
	}

	return await Array.fromAsync(openParquetRowStream<T>(path, options))
}

/**
 * Reads every row of a parquet file, or returns `null` when the file is missing.
 *
 * @throws When the file cannot be parsed or `columns` includes a column the file lacks.
 */
export async function tryReadParquetRows<T>(
	path: PathBuilderLike,
	options: ParquetRowStreamOptions = {}
): Promise<T[] | null> {
	if (!(await pathExists(path))) return null

	return await Array.fromAsync(openParquetRowStream<T>(path, options))
}

/**
 * Counts the rows of a parquet file from its metadata, so the cost stays flat as the row count grows.
 *
 * The function opens its own DuckDB connection.
 *
 * @throws When the file is missing.
 */
export async function countParquetRows(path: PathBuilderLike): Promise<number> {
	if (!(await pathExists(path))) {
		throw new Error(`No parquet file at ${path}`)
	}

	const db = await connectDuckDB()

	try {
		const result = await db.runAndReadAll(
			`SELECT count(*) AS n FROM read_parquet('${escapeSQLString(path.toString())}')`
		)

		const rows = result.getRowObjects() as Array<{ n: unknown }>

		return Number(rows[0]?.n ?? 0)
	} finally {
		db.closeSync()
	}
}

/**
 * Returns a parquet file's column names in file order.
 *
 * The query uses `DESCRIBE`, which lists logical columns.
 * `parquet_schema` lists physical leaves instead, where a list column such as
 * `tokens` appears only as its `element` child.
 *
 * @throws When the file is missing.
 */
export async function parquetColumnNames(path: PathBuilderLike): Promise<string[]> {
	if (!(await pathExists(path))) {
		throw new Error(`No parquet file at ${path}`)
	}

	const db = await connectDuckDB()

	try {
		const result = await db.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${escapeSQLString(path.toString())}')`)

		return (result.getRowObjects() as Array<{ column_name: unknown }>).map((row) => String(row.column_name))
	} finally {
		db.closeSync()
	}
}
