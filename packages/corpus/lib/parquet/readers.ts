/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Parquet reads that answer a promise, beside `./streams`, which answers an iterator.
 *
 *   {@linkcode readParquetRows} raises on a file that is absent or unreadable; {@linkcode tryReadParquetRows} answers
 *   `null` for an absent one. The `try` prefix is the only difference between the two names, and it is what tells a
 *   reader at the call site which of them forgives — the same distinction `statPath` and `tryStat` draw in
 *   `@mailwoman/core/fs`.
 *
 *   Both exist because `?? []` over the raising one turns "I could not read this" into "there is none of it", which is
 *   the silent zero a corpus census reports as a country training on nothing. A caller that wants an absent file to
 *   read as an empty list asks for it by name.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import { connectDuckDB, escapeSQLString } from "#parquet/duckdb"
import { openParquetRowStream, type ParquetRowStreamOptions } from "#parquet/streams"

/**
 * Read every row of a parquet file into memory.
 *
 * Raises when the file is absent, and raises when `columns` names one the file does not carry. Use
 * {@linkcode openParquetRowStream} for a file whose rows do not fit in memory — this one is for a recipe output or a
 * fixture, where the count is known to be small.
 */
export async function readParquetRows<T>(path: PathBuilderLike, options: ParquetRowStreamOptions = {}): Promise<T[]> {
	if (!(await pathExists(path))) {
		throw new Error(`No parquet file at ${String(path)}`)
	}

	return await Array.fromAsync(openParquetRowStream<T>(path, options))
}

/**
 * Read every row of a parquet file, answering `null` when there is no file at `path`.
 *
 * A missing file is the only thing forgiven. A file that exists and cannot be parsed, and a projection naming a column
 * the file lacks, both still raise — those are a corrupt artifact and a caller error, and neither is the same reading
 * as "nobody has built this yet".
 */
export async function tryReadParquetRows<T>(
	path: PathBuilderLike,
	options: ParquetRowStreamOptions = {}
): Promise<T[] | null> {
	if (!(await pathExists(path))) return null

	return await Array.fromAsync(openParquetRowStream<T>(path, options))
}

/**
 * Count the rows of a parquet file without reading them.
 *
 * DuckDB answers this from the file's own metadata, so the cost does not grow with the row count. Raises on an absent
 * file for the reason above: a count is a measurement, and `0` from a file nobody wrote is a different statement than
 * `0` from a file that holds no rows.
 *
 * Takes a PATH rather than a connection, so a caller already holding one pays a second. That is the trade the shared
 * name is worth: the query is `count(*)` over `read_parquet`, and a caller that writes it inline writes the escaping
 * inline with it.
 */
export async function countParquetRows(path: PathBuilderLike): Promise<number> {
	if (!(await pathExists(path))) {
		throw new Error(`No parquet file at ${String(path)}`)
	}

	const db = await connectDuckDB()

	try {
		const result = await db.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${escapeSQLString(String(path))}')`)
		const rows = result.getRowObjects() as Array<{ n: unknown }>

		return Number(rows[0]?.n ?? 0)
	} finally {
		db.closeSync()
	}
}

/**
 * The column names a parquet file carries, in file order.
 *
 * Read this before a projection when the file's schema is in question — it answers what is there, where a failed
 * projection only says that something asked for is missing.
 *
 * Asks `DESCRIBE`, which names the LOGICAL columns. `parquet_schema` walks the physical tree instead, where a LIST
 * column's leaf is its `element` child: filtering that tree to leaves answers `element` once per list and never names
 * `tokens`, `labels` or the span triple, so a caller checking whether the file carries one is told it does not.
 */
export async function parquetColumnNames(path: PathBuilderLike): Promise<string[]> {
	if (!(await pathExists(path))) {
		throw new Error(`No parquet file at ${String(path)}`)
	}

	const db = await connectDuckDB()

	try {
		const result = await db.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${escapeSQLString(String(path))}')`)

		return (result.getRowObjects() as Array<{ column_name: unknown }>).map((row) => String(row.column_name))
	} finally {
		db.closeSync()
	}
}
