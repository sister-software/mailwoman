/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests that a part staged through the columnar stage reads back as the rows that went in, in their order and
 *   with the declared column types, including null, empty and unusual values.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { openColumnarStage, STAGE_BATCH_ROWS } from "#parquet/columnar-stage"
import { openDuckDB } from "#parquet/duckdb"
import { PARQUET_COLUMN_TYPES, PARQUET_COLUMNS, type ParquetRow } from "#parquet/schema"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-columnar-stage-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

const UNUSUAL = ['"quoted"', "back\\slash", "tab\tand\nnewline", "東京都", "", "emoji 🏠", "x".repeat(5000)]

function row(index: number): ParquetRow {
	const tokens = index % 13 === 0 ? [] : [UNUSUAL[index % UNUSUAL.length]!, `t${index % 97}`, `u${index}`]

	return {
		raw: index % 17 === 0 ? UNUSUAL[index % UNUSUAL.length]! : `${index} Main Street`,
		tokens,
		labels: tokens.map((_, position) => (position ? "I-street" : "B-street")),
		span_starts: tokens.map((_, position) => position * 7),
		span_ends: tokens.map((_, position) => position * 7 + 2_000_000_000),
		span_tags: tokens.map(() => "street"),
		country: index % 3 ? "US" : "FR",
		locale: index % 4 ? null : "fr-FR",
		source: "fixture",
		source_id: `fixture-${index}`,
		license: "CC0-1.0",
		register: index % 5 ? null : "formal",
		surface: "attested",
		augmentation: index % 11 ? null : "abbreviate",
		base_source_id: index % 11 ? null : `fixture-${index - 1}`,
	}
}

describe("openColumnarStage", () => {
	it("converts interleaved parts to files that hold their rows, order and types", { timeout: 60_000 }, async () => {
		const count = STAGE_BATCH_ROWS * 2 + 77
		const parts = ["a", "b"]
		const outputs = Object.fromEntries(parts.map((name) => [name, scratch.path(`${name}.parquet`).toString()]))

		{
			using stage = await openColumnarStage(scratch.path("stage.duckdb").toString(), {
				memoryLimitBytes: 512 * 1024 ** 2,
			})

			for (const name of parts) {
				await stage.open(name)
			}

			for (let index = 0; index < count; index++) {
				for (const name of parts) {
					await stage.append(name, row(index))
				}
			}

			// One empty part beside the others, which writes a file with no rows.
			await stage.open("empty")

			for (const name of parts) {
				await stage.convert(name, outputs[name]!)
			}

			await stage.convert("empty", scratch.path("empty.parquet").toString())
		}

		using db = await openDuckDB({ memoryLimitBytes: 512 * 1024 ** 2 })

		for (const name of parts) {
			const described = await db.runAndReadAll(`DESCRIBE SELECT * FROM '${outputs[name]}'`)

			expect(described.getRowObjectsJson().map(({ column_name, column_type }) => [column_name, column_type])).toEqual(
				PARQUET_COLUMNS.map((column) => [column, PARQUET_COLUMN_TYPES[column]])
			)

			const read = await db.runAndReadAll(`SELECT * FROM '${outputs[name]}'`)

			expect(read.getRowObjectsJson()).toEqual(Array.from({ length: count }, (_, index) => ({ ...row(index) })))
		}

		const empty = await db.runAndReadAll(`SELECT count(*) AS n FROM '${scratch.path("empty.parquet").toString()}'`)

		expect(empty.getRowObjectsJson()).toEqual([{ n: "0" }])
	})
})
