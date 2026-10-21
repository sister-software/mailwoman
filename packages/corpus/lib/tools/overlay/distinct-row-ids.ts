/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Give every row of a written parquet its own `source_id`, keeping the shared id as the group key.
 *
 *   A renderer that wrote several texts for one record under one `source_id` leaves a file that
 *   `splitOverlaySlice` cannot route: the hashed place holdout keys a venue row by its venue, so two texts
 *   of one record can fall in different splits, and an attribute keyed by `source_id` states only one
 *   split per id (#2765).
 *
 *   Each id that more than one row carries becomes `<id>#<first 12 hex of sha256(raw)>`. The part before
 *   `#` is the record's id, so a reader grouping the rendered variants of one record splits at the last
 *   `#`. An id one row carries is left unchanged, so the overlap audit still joins those rows by their
 *   original identity.
 */

import type { PathBuilderLike } from "path-ts"

import { escapeSQLString, openDuckDB, type DuckDBLimits } from "#parquet/duckdb"
import { PARQUET_COMPRESSION } from "#parquet/schema"

/**
 * The separator between a record's id and the per-row suffix {@linkcode distinctRowIDs} appends.
 */
export const ROW_ID_SEPARATOR = "#"

export interface DistinctRowIDsOptions {
	input: PathBuilderLike
	/**
	 * The parquet written.
	 *
	 * It must differ from `input`, because a corpus file is replaced rather than rewritten.
	 */
	output: PathBuilderLike
	limits?: DuckDBLimits
}

export interface DistinctRowIDsResult {
	rows: number
	/**
	 * The ids more than one row carried in `input`.
	 */
	sharedIDs: number
	/**
	 * The rows whose id was rewritten.
	 */
	rewrittenRows: number
}

/**
 * Write `input` to `output` with every shared `source_id` made distinct per row,
 * row order and every other column unchanged.
 *
 * @throws When two rows share both `source_id` and `raw`, since a suffix drawn from the
 * text cannot tell them apart and such rows are duplicates for the caller to remove.
 */
export async function distinctRowIDs(options: DistinctRowIDsOptions): Promise<DistinctRowIDsResult> {
	const input = options.input.toString()
	const output = options.output.toString()

	if (input === output) throw new Error(`distinctRowIDs writes a new file; ${input} is both input and output`)

	using db = await openDuckDB(options.limits)

	const source = `read_parquet('${escapeSQLString(input)}', file_row_number = true)`

	const duplicates = (
		await db.runAndReadAll(
			`SELECT source_id, count(*) AS n FROM ${source} GROUP BY source_id, raw HAVING count(*) > 1 LIMIT 3`
		)
	).getRowObjectsJson()

	if (duplicates.length) {
		throw new Error(
			`${input} holds rows that share both source_id and raw (${duplicates.map((row) => String(row["source_id"])).join(", ")}); ` +
				`remove the duplicates before making the ids distinct.`
		)
	}

	const summary = (
		await db.runAndReadAll(
			`SELECT count(*) AS rows, count(DISTINCT source_id) FILTER (WHERE shared) AS shared_ids, ` +
				`count(*) FILTER (WHERE shared) AS rewritten FROM ` +
				`(SELECT source_id, count(*) OVER (PARTITION BY source_id) > 1 AS shared FROM ${source})`
		)
	).getRowObjectsJson()[0]!

	await db.run(
		`COPY (SELECT * EXCLUDE (file_row_number, shared) REPLACE (` +
			`CASE WHEN shared THEN source_id || '${ROW_ID_SEPARATOR}' || substr(sha256(raw), 1, 12) ELSE source_id END AS source_id) ` +
			`FROM (SELECT *, count(*) OVER (PARTITION BY source_id) > 1 AS shared FROM ${source}) ORDER BY file_row_number) ` +
			`TO '${escapeSQLString(output)}' (FORMAT parquet, COMPRESSION ${PARQUET_COMPRESSION})`
	)

	const distinct = (
		await db.runAndReadAll(
			`SELECT count(*) AS rows, count(DISTINCT source_id) AS ids FROM read_parquet('${escapeSQLString(output)}')`
		)
	).getRowObjectsJson()[0]!

	if (distinct["rows"] !== distinct["ids"] || distinct["rows"] !== summary["rows"]) {
		throw new Error(
			`${output} holds ${String(distinct["rows"])} rows over ${String(distinct["ids"])} ids; ` +
				`${input} held ${String(summary["rows"])} rows, so the rewrite did not give every row its own id`
		)
	}

	return {
		rows: Number(summary["rows"]),
		sharedIDs: Number(summary["shared_ids"]),
		rewrittenRows: Number(summary["rewritten"]),
	}
}
