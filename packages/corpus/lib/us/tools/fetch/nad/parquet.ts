// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Converts the NAD bulk release's delimited text to one Parquet file sorted by state and county, so a query about one
 *   county reads only that county's row groups.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import type { PathBuilderLike } from "path-ts"

import { escapeSQLIdentifier, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { recordPathFor } from "#parquet/record"

/**
 * What a conversion read and wrote, kept beside the Parquet file.
 */
export interface NADParquetRecord {
	/**
	 * The hash of the archive the text came from.
	 * A conversion is current while this matches.
	 */
	sourceSHA256: string
	member: string
	rows: number
	rowsByState: Record<string, number>
	sortedBy: string[]
	writtenAt: string
}

/**
 * The columns the sort reads, in order.
 *
 * `UUID` breaks ties so two runs write rows in the same order.
 */
const SORT_COLUMNS = ["State", "County", "UUID"] as const

/**
 * Rows per Parquet row group.
 *
 * A county's rows span few groups, so a county query skips the rest.
 */
const ROW_GROUP_ROWS = 1_000_000

/**
 * The record of a Parquet file converted from `member` of the archive hashed `sourceSHA256`.
 *
 * Returns `null` when the Parquet file or its record is absent, or when the
 * record states another archive or member.
 */
export async function readCurrentNADParquetRecord(
	parquetPath: PathBuilderLike,
	sourceSHA256: string,
	member: string
): Promise<NADParquetRecord | null> {
	const recordPath = recordPathFor(parquetPath)

	if (!(await pathExists(parquetPath)) || !(await pathExists(recordPath))) return null

	const recorded = await readLocalJSONFile<NADParquetRecord>(recordPath)

	return recorded.sourceSHA256 === sourceSHA256 && recorded.member === member ? recorded : null
}

/**
 * Converts one extracted NAD text file to sorted Parquet, or keeps the existing file
 * when its record holds the same archive hash.
 *
 * Every column is read as text, so ZIP Codes and house numbers keep their leading zeros.
 * The sort runs on DuckDB's default threads, and the write runs on one thread,
 * because a multi-threaded `COPY` moves row-group boundaries between runs.
 *
 * @throws When the text lacks a column the sort reads.
 */
export async function convertNADToParquet(options: {
	textPath: PathBuilderLike
	parquetPath: PathBuilderLike
	sourceSHA256: string
	member: string
	report?: (line: string) => void
}): Promise<{ record: NADParquetRecord; converted: boolean }> {
	const { textPath, parquetPath, sourceSHA256, member, report } = options
	const recordPath = recordPathFor(parquetPath)
	const current = await readCurrentNADParquetRecord(parquetPath, sourceSHA256, member)

	if (current) {
		report?.(`  parquet current: ${current.rows.toLocaleString()} rows from ${member}`)

		return { record: current, converted: false }
	}

	using db = await openDuckDB()
	const source = `read_csv('${escapeSQLString(String(textPath))}', header = true, all_varchar = true)`
	const described = (await db.runAndReadAll(`DESCRIBE SELECT * FROM ${source}`)).getRowObjects()
	const columns = new Set(described.map((row) => String(row["column_name"])))
	const missing = SORT_COLUMNS.filter((column) => !columns.has(column))

	if (missing.length) {
		throw new Error(`NAD text ${member} lacks ${missing.join(", ")}; its columns are ${[...columns].join(", ")}`)
	}

	const orderBy = SORT_COLUMNS.map(escapeSQLIdentifier).join(", ")

	report?.(`  sorting ${member} by ${SORT_COLUMNS.join(", ")}`)
	await db.run(`CREATE TABLE nad AS SELECT * FROM ${source} ORDER BY ${orderBy}`)

	report?.(`  writing ${parquetPath}`)
	await db.run("SET threads = 1")
	await db.run("SET preserve_insertion_order = true")

	await db.run(
		`COPY nad TO '${escapeSQLString(String(parquetPath))}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_ROWS})`
	)

	const byState = (
		await db.runAndReadAll(`SELECT "State" AS state, count(*) AS n FROM nad GROUP BY 1 ORDER BY 1`)
	).getRowObjects()

	const rowsByState = Object.fromEntries(byState.map((row) => [String(row["state"] ?? ""), Number(row["n"])]))

	const record: NADParquetRecord = {
		sourceSHA256,
		member,
		rows: Object.values(rowsByState).reduce((sum, count) => sum + count, 0),
		rowsByState,
		sortedBy: [...SORT_COLUMNS],
		writtenAt: new Date().toISOString(),
	}

	await writeLocalJSONFile(record, recordPath)

	return { record, converted: true }
}
