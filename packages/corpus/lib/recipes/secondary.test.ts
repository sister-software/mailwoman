/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The secondary-address rows equal the rows recorded in `fixtures/builders/secondary/record.json`, which the
 *   Python module first wrote and which was re-frozen when the recipe moved to `SeededRandom` (#2879 T62).
 */

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
import { ReferenceFixture } from "#test-kit"

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
	const reference = await ReferenceFixture.read<SecondaryRecord>(RECORD)
	const record = reference.values

	it("draw from the recorded seed", () => {
		expect(record.seed).toBe(SECONDARY_SEED)
	})

	it("equal the recorded rows, in order", async () => {
		const rows = generateSecondaryRows(record.cap)

		// The cap counts base addresses, and each base yields several rows.
		expect(rows.length).toBeGreaterThanOrEqual(record.cap)
		reference.expect("rows", rows)
		await reference.save()
	})

	it("hash to the recorded full output", async () => {
		const rows = generateSecondaryRows(record.full_cap)

		expect(rows.length).toBeGreaterThanOrEqual(record.full_cap)
		reference.expect("full_rows", rows.length)
		reference.expect("full_rows_sha256", sha256Hex(rows.map((row) => canonicalJSON(row) + "\n").join("")))
		await reference.save()
	})

	it("cover each span's own text", () => {
		const [first] = generateSecondaryRows(1)

		expect(first!.raw).toBe("139 Bouverie Street, STE 17, Melbourne, VIC 3000")

		expect(spanTexts(first!)).toEqual([
			["house_number", "139"],
			["street", "Bouverie Street"],
			["unit_designator", "STE"],
			["unit", "17"],
			["locality", "Melbourne"],
			["region", "VIC"],
			["postcode", "3000"],
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

		const described = await db.runAndReadAll(
			`DESCRIBE SELECT * FROM read_parquet('${escapeSQLString(path.toString())}')`
		)

		expect(described.getRowObjects().map((row) => [row["column_name"], row["column_type"]])).toEqual([
			["raw", "VARCHAR"],
			["span_starts", "BIGINT[]"],
			["tags", "VARCHAR[]"],
		])

		// DuckDB reads a BIGINT as a bigint.
		await expect(readParquetRows(path)).resolves.toEqual([{ raw: "a b", span_starts: [0n, 2n], tags: ["x", "y"] }])
	})
})
