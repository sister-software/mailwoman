/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file These tests check the holdout policy applied to an existing overlay Parquet file.
 *
 *   The cases here are the two ways an overlay defeats a holdout. A row whose postcode the policy
 *   names must leave the train split. A row whose components cannot be read must stop the run
 *   rather than default to train, because defaulting to train is what the policy exists to prevent.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { sha256File } from "@mailwoman/core/hash"
import { afterAll, describe, expect, it } from "vitest"

import type { ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { gbOverlayRow } from "#test-kit"
import { readSplitAttribute, splitOfSourceID } from "#tools/overlay/split-attribute"
import { holdoutComponents, splitOverlaySlice } from "#tools/overlay/split-overlay"
import { defaultHoldouts, type SplitName, splitForRow } from "#utils/split"

const root = await temporaryDirectory("mw-split-overlay-")

afterAll(() => root[Symbol.asyncDispose]())

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

const gbRow = gbOverlayRow

/**
 * GB rows across every holdout prefix and around them, plus enough held-out
 * rows that both `val` and `test` draw.
 */
function fixtureRows(): ParquetRow[] {
	const rows: ParquetRow[] = [
		gbRow("gb-1", "Parc Venton Close", "Camborne", "TR14 7TT"),
		gbRow("gb-2", "Bangor Road", "Conwy", "LL32 8EA"),
		gbRow("gb-3", "Stubbing Drive", "Hebden Bridge", "HX7 6LS"),
		gbRow("gb-4", "Baker Street", "London", "NW1 6XE"),
		gbRow("gb-5", "Hope Street", "Liverpool", "L1 9BP"),
	]

	for (let index = 0; index < 60; index++) {
		const postcode = ["TR1 1AA", "LL11 2BB", "HX1 3CC", "L1 4DD", "LS1 5EE", "M1 6FF"][index % 6]!

		rows.push(gbRow(`gb-fixture-${index}`, `${index} High Street`, "Somewhere", postcode))
	}

	return rows
}

describe("splitOverlaySlice", () => {
	it("decides every row's split exactly as splitForRow does under the same policy", async () => {
		const input = root.path("part-gb.parquet")
		const rows = fixtureRows()

		await writeParquetFile(rows, input, FIXTURE_DERIVATION)

		const result = await splitOverlaySlice({ input, outputDir: root.path })
		const attribute = await readSplitAttribute(result.attribute)
		const expected: Record<SplitName, number> = { train: 0, val: 0, test: 0 }

		// `splitForRow` over the components read back from each row is the decision the filename route made
		// when it bucketed rows into `<stem>.<split>.parquet`, so equality here keeps every row's split.
		for (const [index, row] of rows.entries()) {
			const components = holdoutComponents(row, index, "fixture")
			const split = splitForRow({ source_id: row.source_id, country: row.country, components }, defaultHoldouts())

			expect(splitOfSourceID(attribute, row.source_id), row.source_id).toBe(split)

			expected[split]++
		}

		expect(result.counts).toEqual(expected)
		expect(attribute.counts).toEqual(expected)
		expect(expected.val).toBeGreaterThan(0)
		expect(expected.test).toBeGreaterThan(0)
		expect(attribute.file).toEqual({ name: "part-gb.parquet", sha256: await sha256File(input), rows: rows.length })
		expect(result.attribute.endsWith(`part-gb.split.${result.policyHash}.json`)).toBe(true)
	})

	it("keeps a Liverpool postcode in train, because `L` is not one of the holdout's prefixes", async () => {
		const input = root.path("part-liverpool.parquet")

		await writeParquetFile([gbRow("gb-6", "Hope Street", "Liverpool", "L1 9BP")], input, FIXTURE_DERIVATION)

		const result = await splitOverlaySlice({ input, outputDir: root.path })
		const attribute = await readSplitAttribute(result.attribute)

		expect(result.counts.train).toBe(1)
		expect(attribute.val).toEqual([])
		expect(attribute.test).toEqual([])
	})

	it("names a different attribute file when the holdout table changes", async () => {
		const input = root.path("part-london.parquet")

		await writeParquetFile([gbRow("gb-7", "Baker Street", "London", "NW1 6XE")], input, FIXTURE_DERIVATION)

		const policy = await splitOverlaySlice({ input, outputDir: root.path })

		const widened = await splitOverlaySlice({
			input,
			outputDir: root.path,
			holdouts: { ...defaultHoldouts(), GB: { postcodePrefixes: ["NW"] } },
		})

		expect(widened.policyHash).not.toBe(policy.policyHash)
		expect(widened.counts.train).toBe(0)
	})
})

describe("holdoutComponents", () => {
	it("reads the postcode back out of `raw` at the span the row records", () => {
		const row = gbRow("gb-8", "Parc Venton Close", "Camborne", "TR14 7TT")

		expect(holdoutComponents(row, 0, "fixture")).toEqual({
			locality: "Camborne",
			postcode: "TR14 7TT",
		})
	})

	it("refuses a row carrying no span triple rather than reading it as a row with no postcode", () => {
		// The key is absent rather than set to `undefined`, which is the shape a file written
		// before the span triple existed produces.
		const { span_tags, ...row } = gbRow("gb-9", "Parc Venton Close", "Camborne", "TR14 7TT")

		expect(span_tags).toHaveLength(3)
		expect(() => holdoutComponents(row, 3, "fixture")).toThrow(/row 3/)
	})

	it("refuses a span triple whose three arrays disagree in length", () => {
		const row = { ...gbRow("gb-10", "Parc Venton Close", "Camborne", "TR14 7TT"), span_ends: [1] }

		expect(() => holdoutComponents(row, 4, "fixture")).toThrow(/parallel/)
	})
})
