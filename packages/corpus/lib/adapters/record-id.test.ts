/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A rendered row's `source_id` is unique within its split, and its record is the part before the last `#`.
 */

import { describe, expect, it } from "vitest"

import {
	rawTextDiscriminator,
	recordIDOf,
	recordIDSQL,
	RenderedRowIDs,
	ROW_ID_SEPARATOR,
	rowSourceID,
} from "#adapters/record-id"
import { stableSourceID } from "#adapters/source-id"
import { openDuckDB } from "#parquet/duckdb"
import { type SplitName, splitForRow } from "#utils/split"

describe("rowSourceID", () => {
	it("reads back the record id, through an augmentation suffix", () => {
		const id = rowSourceID("rendered-de-184f944b0b1f", rawTextDiscriminator("Hauptstraße, 02788 Hirschfelde"))

		expect(id).toMatch(/^rendered-de-184f944b0b1f#[0-9a-f]{12}$/u)
		expect(recordIDOf(id)).toBe("rendered-de-184f944b0b1f")
		expect(recordIDOf(`${id}+drop-commas`)).toBe("rendered-de-184f944b0b1f")
		expect(recordIDOf("usgov-imls-pls-WY0008")).toBe("usgov-imls-pls-WY0008")
	})

	it("refuses a record id that already holds the separator", () => {
		expect(() => rowSourceID(`a${ROW_ID_SEPARATOR}b`, "c")).toThrow(/already holds/u)
		expect(() => rowSourceID("a", "")).toThrow(/empty/u)
	})

	it("reads the same record in DuckDB as recordIDOf", async () => {
		const ids = ["a-1", "a-1#0123456789ab", "a-1#002+case-lower", "x#y#z", "#lead"]
		const values = ids.map((id) => `('${id}')`).join(", ")

		using db = await openDuckDB()

		const query = `SELECT ${recordIDSQL("id")} AS record FROM (VALUES ${values}) v(id)`
		const rows = (await db.runAndReadAll(query)).getRowObjectsJson()

		expect(rows.map((row) => row["record"])).toEqual(ids.map(recordIDOf))
	})
})

describe("RenderedRowIDs", () => {
	// Three DE tuples in postcode area 02.
	// DE holds that area out, so every row lands in val or test.
	const tuples = [
		{ street: "Hauptstraße", house_number: "4", locality: "Hirschfelde", postcode: "02788" },
		{ street: "Bahnhofstraße", house_number: "12", locality: "Zittau", postcode: "02763" },
		{ street: "Markt", house_number: "1", locality: "Görlitz", postcode: "02826" },
	]

	const renderings = (t: (typeof tuples)[number]) => [
		`${t.street} ${t.house_number}, ${t.postcode} ${t.locality}`,
		`${t.street} ${t.house_number} ${t.postcode} ${t.locality}`,
	]

	// [tuple, rendering] pairs drawn with replacement, as `rendered-de` draws them.
	// The last two repeat earlier draws.
	const pairs = [
		[0, 0],
		[1, 0],
		[2, 0],
		[0, 1],
		[1, 1],
		[2, 1],
		[0, 0],
		[2, 1],
	] as const

	const draws = pairs.map(([t, r]) => ({ tuple: tuples[t]!, raw: renderings(tuples[t]!)[r]! }))

	it("gives every written row an id unique within its split, under a stable record id", () => {
		const ids = new RenderedRowIDs()
		const bySplit: Record<SplitName, string[]> = { train: [], val: [], test: [] }
		const splitOfRecord = new Map<string, SplitName>()

		for (const { tuple, raw } of draws) {
			const record = stableSourceID("rendered-de", tuple)
			const id = ids.claim(record, raw)

			if (!id) continue

			expect(recordIDOf(id)).toBe(record)

			const split = splitForRow({ source_id: id, country: "DE", components: { postcode: tuple.postcode } })

			expect(split).not.toBe("train")
			expect(splitOfRecord.get(record) ?? split).toBe(split)

			splitOfRecord.set(record, split)
			bySplit[split].push(id)
		}

		for (const written of Object.values(bySplit)) {
			expect(new Set(written).size).toBe(written.length)
		}

		// Three tuples times two renderings.
		// The repeated draws were refused.
		expect(bySplit.val.length + bySplit.test.length).toBe(6)
		expect(splitOfRecord.size).toBe(3)
	})

	it("refuses a record's text it has already written", () => {
		const ids = new RenderedRowIDs()

		expect(ids.claim("r-1", "a")).toBe(rowSourceID("r-1", rawTextDiscriminator("a")))
		expect(ids.claim("r-1", "a")).toBeNull()
		expect(ids.claim("r-1", "b")).not.toBeNull()
		expect(ids.claim("r-2", "a")).not.toBeNull()
	})
})
