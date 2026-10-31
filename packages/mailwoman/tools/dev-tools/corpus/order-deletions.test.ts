/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { readParquetRows } from "@mailwoman/corpus/parquet/readers"
import { readDeletionIDs } from "@mailwoman/corpus/tools/overlay/deletions"
import { postcodePlacement } from "@mailwoman/postcode/country-formats"
import { afterAll, describe, expect, test } from "vitest"

import {
	findReversedRows,
	postcodeSide,
	rowPostcodeOrder,
	writeNativeRows,
	writeSourceIDSidecar,
} from "./order/deletions.ts"

const directory = await temporaryDirectory("mw-order-deletions-")

afterAll(() => directory[Symbol.asyncDispose]())

describe("postcodeSide", () => {
	test("reads the side of the locality-and-region block", () => {
		// "Calle Mayor 12, 28013 Madrid"
		expect(postcodeSide(["street", "house_number", "postcode", "locality"], [0, 12, 16, 22])).toBe("before_locality")

		// "Calle Mayor 12, Madrid, M, 28013"
		expect(postcodeSide(["street", "house_number", "locality", "region", "postcode"], [0, 12, 16, 24, 27])).toBe(
			"after_locality"
		)
	})

	test("is null without one postcode and a locality, or with admin spans on both sides", () => {
		expect(postcodeSide(["street", "locality"], [0, 5])).toBeNull()
		expect(postcodeSide(["street", "postcode", "region"], [0, 5, 11])).toBeNull()
		expect(postcodeSide(["locality", "postcode", "region"], [0, 7, 13])).toBeNull()
		expect(postcodeSide(["postcode", "locality", "postcode"], [0, 6, 13])).toBeNull()
	})
})

describe("rowPostcodeOrder", () => {
	test("compares the side with the country's libaddressinput placement", () => {
		expect(postcodePlacement("ES")).toBe("before_locality")

		const row = {
			source_id: "x",
			country: "es",
			span_tags: ["street", "locality", "postcode"],
			span_starts: [0, 9, 16],
		}

		expect(rowPostcodeOrder(row)).toBe("reversed")
		expect(rowPostcodeOrder({ ...row, span_starts: [0, 16, 9] })).toBe("native")
		expect(rowPostcodeOrder({ ...row, country: "JP" })).toBeNull()
		expect(rowPostcodeOrder({ ...row, span_tags: null })).toBeNull()
	})
})

describe("findReversedRows and writeSourceIDSidecar", () => {
	test("writes the reversed ids as a sidecar the deletion loader reads", async () => {
		const input = directory.path("in.parquet").toString()
		using db = await openDuckDB()

		await db.run(
			`COPY (SELECT * FROM (VALUES
				('es-native', 'ES', ['street', 'postcode', 'locality'], [0, 9, 15]),
				('es-reversed', 'ES', ['street', 'locality', 'postcode'], [0, 9, 16]),
				('es-reversed', 'ES', ['street', 'postcode', 'locality'], [0, 9, 15]),
				('pl-reversed', 'PL', ['street', 'locality', 'region', 'postcode'], [0, 9, 16, 22]),
				('br-native', 'BR', ['street', 'locality', 'postcode'], [0, 9, 16]),
				('de-reversed', 'DE', ['street', 'locality', 'postcode'], [0, 9, 16])
			) t(source_id, country, span_tags, span_starts)) TO '${input}' (FORMAT parquet)`
		)

		const all = await findReversedRows(input)

		expect(all.ids.toSorted()).toEqual(["de-reversed", "es-reversed", "pl-reversed"])
		expect(all.countries.get("ES")).toEqual({ rows: 3, native: 2, reversed: 1, nativeSharingID: 1 })
		expect(all.countries.get("BR")).toEqual({ rows: 1, native: 1, reversed: 0, nativeSharingID: 0 })

		const scoped = await findReversedRows(input, ["es", "PL"])

		expect(scoped.ids.toSorted()).toEqual(["es-reversed", "pl-reversed"])
		expect(scoped.countries.has("DE")).toBe(false)

		const sidecar = directory.path("sidecar.parquet").toString()

		await writeSourceIDSidecar(scoped.ids, sidecar)

		expect([...(await readDeletionIDs(sidecar))].toSorted()).toEqual(["es-reversed", "pl-reversed"])
	})

	test("writes the native rows, keeping a native row that shares an id with a reversed one", async () => {
		const input = directory.path("rows.parquet").toString()
		using db = await openDuckDB()

		await db.run(
			`COPY (SELECT raw, string_split(raw, ' ') AS tokens, list_transform(string_split(raw, ' '), lambda t: 'O') AS labels,
				span_starts, list_transform(span_starts, lambda s: s + 1) AS span_ends, span_tags, country, 'es-ES' AS locale,
				'overture' AS source, source_id, 'x' AS license, NULL::VARCHAR AS register, 'address' AS surface,
				NULL::VARCHAR AS augmentation, NULL::VARCHAR AS base_source_id
			FROM (VALUES
				('a', 'ES', 'C 1 28013 Madrid', ['street', 'postcode', 'locality'], [0, 4, 10]),
				('a', 'ES', 'C 1 Madrid 28013', ['street', 'locality', 'postcode'], [0, 4, 11]),
				('b', 'ES', 'C 1 Madrid', ['street', 'locality'], [0, 4])
			) t(source_id, country, raw, span_tags, span_starts)) TO '${input}' (FORMAT parquet)`
		)

		const output = directory.path("native.parquet").toString()
		const { countries, record } = await writeNativeRows(input, output)

		expect(countries.get("ES")).toEqual({ rowsIn: 3, rowsOut: 2 })
		expect(record.rows).toBe(2)
		expect(record.source).toBe("overture")
		expect(record.derivation.config).toMatchObject({ placements: { ES: "before_locality" } })

		const kept = await readParquetRows<{ raw: string }>(output, { columns: ["raw"] })

		expect(kept.map((row) => row.raw).toSorted()).toEqual(["C 1 28013 Madrid", "C 1 Madrid"])
	})

	test("refuses to write an empty sidecar", async () => {
		await expect(writeSourceIDSidecar([], directory.path("empty.parquet"))).rejects.toThrow(/no source_id/)
	})
})
