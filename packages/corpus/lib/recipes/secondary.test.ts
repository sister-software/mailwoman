/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The secondary-address rows equal the rows `corpora/secondary.py` generated, recorded in
 *   `fixtures/builders/secondary/record.json` before the Python module was deleted.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { readParquetRows } from "#parquet/readers"
import { ParquetColumnKind, writeColumnParquetFile } from "#parquet/writers"
import {
	checkSecondaryRows,
	generateSecondaryRows,
	SECONDARY_SEED,
	secondaryTagCoverage,
	type SecondaryRow,
} from "#recipes/secondary"

interface SecondaryRecord {
	seed: number
	cap: number
	rows: SecondaryRow[]
	full_cap: number
	full_rows: number
	full_rows_sha256: string
}

const RECORD = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "secondary", "record.json")

const spanTexts = (row: SecondaryRow) =>
	row.span_tags.map((tag, index) => [tag, [...row.raw].slice(row.span_starts[index], row.span_ends[index]).join("")])

describe("the secondary-address rows", async () => {
	const record = await readLocalJSONFile<SecondaryRecord>(RECORD)

	it("draw from the recorded seed", () => {
		expect(record.seed).toBe(SECONDARY_SEED)
	})

	it("equal the recorded Python rows, in order", () => {
		const rows = generateSecondaryRows(record.cap)

		expect(rows.map((row) => canonicalJSON(row))).toEqual(record.rows.map((row) => canonicalJSON(row)))
	})

	it("hash to the recorded full output", () => {
		const rows = generateSecondaryRows(record.full_cap)

		expect(rows).toHaveLength(record.full_rows)
		expect(sha256Hex(rows.map((row) => canonicalJSON(row) + "\n").join(""))).toBe(record.full_rows_sha256)
	})

	it("cover each span's own text", () => {
		const [first] = generateSecondaryRows(1)

		expect(first!.raw).toBe("789 Elm Boulevard, STE 200, Miami, FL 33101")

		expect(spanTexts(first!)).toEqual([
			["house_number", "789"],
			["street", "Elm Boulevard"],
			["unit_designator", "STE"],
			["unit", "200"],
			["locality", "Miami"],
			["region", "FL"],
			["postcode", "33101"],
		])
	})

	it("emit every STAGE4 secondary tag", () => {
		expect([...secondaryTagCoverage(generateSecondaryRows(15)).keys()]).toEqual([
			"building_designator",
			"building_id",
			"entrance",
			"level_designator",
			"level_id",
			"staircase",
			"unit",
			"unit_designator",
		])
	})

	it("refuse a span that covers only whitespace", () => {
		const [row] = generateSecondaryRows(1)

		expect(() => checkSecondaryRows([{ ...row!, raw: " ".repeat(row!.raw.length) }])).toThrow(/empty span text/)
	})
})

describe("writeColumnParquetFile", () => {
	it("writes the columns it is given, in order and with their types", async () => {
		await using scratch = await temporaryDirectory("mailwoman-secondary-")
		const path = scratch.path("rows.parquet")

		await writeColumnParquetFile(
			[{ raw: "a b", span_starts: [0, 2], tags: ["x", "y"] }],
			[
				["raw", ParquetColumnKind.String],
				["span_starts", ParquetColumnKind.Int64List],
				["tags", ParquetColumnKind.StringList],
			],
			path
		)

		using db = await openDuckDB()
		const described = await db.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${escapeSQLString(path)}')`)

		expect(described.getRowObjects().map((row) => [row["column_name"], row["column_type"]])).toEqual([
			["raw", "VARCHAR"],
			["span_starts", "BIGINT[]"],
			["tags", "VARCHAR[]"],
		])

		// DuckDB reads a BIGINT as a bigint.
		expect(await readParquetRows(path)).toEqual([{ raw: "a b", span_starts: [0n, 2n], tags: ["x", "y"] }])
	})
})
