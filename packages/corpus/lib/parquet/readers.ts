/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Parquet reads that answer a promise, beside `./streams`, which answers an iterator.
 *
 *   The name carries the contract wherever two helpers differ only in what they forgive, the way `statPath` and
 *   `tryStat` do in `@mailwoman/core/fs`: {@linkcode readParquetRows} raises on a file that is absent or unreadable,
 *   {@linkcode tryReadParquetRows} answers `null`. A caller that treats a missing file as an empty corpus writes
 *   `?? []` over the raising one and gets the same silent zero this split exists to prevent, so the forgiving name is
 *   the one that says so out loud.
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
 */
export async function parquetColumnNames(path: PathBuilderLike): Promise<string[]> {
	if (!(await pathExists(path))) {
		throw new Error(`No parquet file at ${String(path)}`)
	}

	const db = await connectDuckDB()

	try {
		const result = await db.runAndReadAll(
			`SELECT name FROM parquet_schema('${escapeSQLString(String(path))}') WHERE num_children IS NULL`
		)

		return (result.getRowObjects() as Array<{ name: unknown }>).map((row) => String(row.name))
	} finally {
		db.closeSync()
	}
}
