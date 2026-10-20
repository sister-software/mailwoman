/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A corpus file of either schema reads as the current columns.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { openCorpusRowStream } from "#parquet/corpus-rows"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { corpusRowFromParquet, type ParquetRow, rowToParquet } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { committedRowLicenses } from "#source-register/row-license"
import { type LabeledRow, SurfaceOrigin } from "#types"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-corpus-rows-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

/**
 * Write a file in the v0.7.x column layout: `corpus_version` and `recipe` where `augmentation` now sits.
 *
 * The three rows are the three shapes measured in `v0.7.10-gb-county`: a base row,
 * an augmentation of it, and an overlay row whose `recipe` holds its producer's name.
 */
async function writeOldSchemaFile(path: string): Promise<void> {
	using db = await openDuckDB()

	await db.run(
		`COPY (SELECT * FROM (VALUES ` +
			`('Paris', 'ban', 'ban-1', '0.7.0-de-holdout', 'Licence Ouverte 2.0', NULL, NULL), ` +
			`('paris', 'ban', 'ban-1+case-lower', '0.7.0-de-holdout', 'Licence Ouverte 2.0', 'case-lower', 'ban-1'), ` +
			`('Hope Street', 'rendered-gb-os-open', 'gb-1', '0.7.10-gb-county', 'OS OpenData GB tuples (OGL-UK-3.0)', 'rendered-gb-os-open', NULL)` +
			`) AS t(raw, source, source_id, corpus_version, license, recipe, base_source_id)) ` +
			`TO '${escapeSQLString(path)}' (FORMAT parquet)`
	)
}

const labeled = (over: Partial<LabeledRow>): LabeledRow => ({
	raw: "Paris",
	components: { locality: "Paris" },
	country: "FR",
	source: "ban",
	source_id: "ban-1",
	license: "Licence Ouverte 2.0",
	register: "ban",
	surface: SurfaceOrigin.Attested,
	tokens: ["Paris"],
	labels: ["B-locality"],
	span_starts: [0],
	span_ends: [5],
	span_tags: ["locality"],
	...over,
})

describe("corpusRowFromParquet", () => {
	it("passes a current row through unchanged", () => {
		const row = { raw: "Paris", source: "ban", augmentation: "case-lower", base_source_id: "ban-1" }

		expect(corpusRowFromParquet(row)).toBe(row)
	})

	it("reads an older row's recipe as an augmentation only where base_source_id is set", () => {
		expect(
			corpusRowFromParquet({ source: "ban", corpus_version: "0.7.0", recipe: "case-lower", base_source_id: "ban-1" })
		).toEqual({ source: "ban", augmentation: "case-lower", base_source_id: "ban-1" })

		expect(
			corpusRowFromParquet({ source: "rendered-gb-os-open", recipe: "rendered-gb-os-open", base_source_id: null })
		).toEqual({ source: "rendered-gb-os-open", augmentation: null, base_source_id: null })
	})
})

describe("openCorpusRowStream", () => {
	it("reads an older file and a current file as the same columns", async () => {
		const old = scratch.path("old.parquet").toString()
		const current = scratch.path("current.parquet").toString()

		await writeOldSchemaFile(old)

		await writeParquetFile(
			[
				rowToParquet(labeled({})),
				rowToParquet(
					labeled({
						raw: "paris",
						source_id: "ban-1+case-lower",
						augmentation: { name: "case-lower", base_source_id: "ban-1" },
					})
				),
			],
			current,
			{ extractHash: "fixture", codeHash: "fixture", config: {} }
		)

		const oldRows = await Array.fromAsync(openCorpusRowStream(old))
		const currentRows = await Array.fromAsync(openCorpusRowStream(current))

		for (const row of [...oldRows, ...currentRows]) {
			expect(row).not.toHaveProperty("corpus_version")
			expect(row).not.toHaveProperty("recipe")
			expect(row).toHaveProperty("augmentation")
		}

		const pick = (rows: ParquetRow[]) =>
			rows.filter((row) => row.source === "ban").map(({ source_id, augmentation }) => ({ source_id, augmentation }))

		expect(pick(oldRows)).toEqual(pick(currentRows))
		expect(oldRows.find((row) => row.source === "rendered-gb-os-open")!.augmentation).toBeNull()

		// The older file's license column holds what it held.
		// The current one holds the register's id.
		expect(oldRows[0]!.license).toBe("Licence Ouverte 2.0")
		expect(currentRows[0]!.license).toBe((await committedRowLicenses()).licenseOf("ban"))
	})

	it("answers a projection of `augmentation` from either schema", async () => {
		const old = scratch.path("old.parquet").toString()

		await writeOldSchemaFile(old)

		const rows = await Array.fromAsync(openCorpusRowStream(old, { columns: ["source_id", "augmentation"] }))

		expect(rows).toEqual([
			{ source_id: "ban-1", augmentation: null },
			{ source_id: "ban-1+case-lower", augmentation: "case-lower" },
			{ source_id: "gb-1", augmentation: null },
		])
	})

	it("still raises on a projected column neither schema carries", async () => {
		const old = scratch.path("old.parquet").toString()

		await writeOldSchemaFile(old)

		await expect(
			Array.fromAsync(openCorpusRowStream(old, { columns: ["augmentation", "no_such_column"] }))
		).rejects.toThrow(/absent from the file schema/u)
	})
})
