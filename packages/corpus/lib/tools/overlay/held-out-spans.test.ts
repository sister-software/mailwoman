/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `countHoldoutSpans` and `holdoutSpanFindings`: region and locality spans on each side of the split.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import type { ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import {
	countHoldoutSpans,
	type HoldoutSpanCount,
	holdoutSpanFindings,
	REGION_SURFACE_MIN_ROWS,
} from "#tools/overlay/held-out-spans"
import { splitOverlaySlice } from "#tools/overlay/split-slice"
import type { CountryHoldout } from "#utils/split"

const root = await temporaryDirectory("mw-held-out-spans-")

afterAll(() => root[Symbol.asyncDispose]())

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

/**
 * An ES row `<street>, <locality>, <region>[ <postcode>]` with the locality, region and postcode labeled.
 */
function esRow(sourceID: string, raw: string, postcode?: string): ParquetRow {
	const text = postcode ? `${raw} ${postcode}` : raw
	const regionStart = raw.lastIndexOf(", ") + 2
	const localityStart = raw.lastIndexOf(", ", regionStart - 3) + 2
	const starts = [localityStart, regionStart]
	const ends = [regionStart - 2, raw.length]
	const tags = ["locality", "region"]

	if (postcode) {
		starts.push(raw.length + 1)
		ends.push(text.length)
		tags.push("postcode")
	}

	return {
		raw: text,
		tokens: text.split(" "),
		labels: text.split(" ").map(() => "O"),
		span_starts: starts,
		span_ends: ends,
		span_tags: tags,
		country: "ES",
		locale: "es-ES",
		source: "wof-admin",
		source_id: sourceID,
		license: "CC-BY-4.0",
		register: null,
		surface: "composed",
		augmentation: null,
		base_source_id: null,
	}
}

const HOLDOUTS: Record<string, CountryHoldout> = {
	ES: { regions: ["Illes Balears"], localities: ["Oviedo"], postcodePrefixes: ["070"] },
}

const region = (surface: string, train: number, heldOut: number, trainNoPC = train, heldOutNoPC = heldOut) =>
	({
		country: "ES",
		tag: "region",
		surface,
		trainRows: train,
		heldOutRows: heldOut,
		trainRowsWithoutPostcode: trainNoPC,
		heldOutRowsWithoutPostcode: heldOutNoPC,
	}) satisfies HoldoutSpanCount

describe("countHoldoutSpans", () => {
	it("counts a span by its tag, so a name written inside a street is not a train region span", async () => {
		const trainFile = root.path("train.parquet")
		const testFile = root.path("test.parquet")
		const mixedFile = root.path("mixed.parquet")

		// "Asturias" is written in train only inside a street.
		// As a region it is carried by held-out rows only.
		// The train row in Oviedo is a held-out locality left in train, and the 07001 row a held-out postcode.
		await writeParquetFile(
			[
				esRow("t-1", "Calle Asturias 4, Santander, Cantabria"),
				esRow("t-2", "Gran Vía 1, Madrid, MADRID", "28013"),
				esRow("t-3", "Calle 5, Oviedo, Principado"),
				esRow("t-4", "Calle 6, Palma, Mallorca", "07001"),
			],
			trainFile,
			FIXTURE_DERIVATION
		)

		await writeParquetFile([esRow("x-1", "Calle 1, Gijón, Asturias")], testFile, FIXTURE_DERIVATION)

		await writeParquetFile(
			[
				esRow("m-1", "Calle 2, Sóller, Illes Balears"),
				esRow("m-2", "Calle 3, Oviedo, Asturias"),
				esRow("m-3", "Calle 4, Toledo, Madrid"),
			],
			mixedFile,
			FIXTURE_DERIVATION
		)

		const split = await splitOverlaySlice({ input: mixedFile, outputDir: root.path, holdouts: HOLDOUTS })
		const manifest = root.path("MANIFEST.json")

		await writeLocalJSONFile(
			{
				slices: [
					{ path: trainFile.toString(), split: "train" },
					{ path: testFile.toString(), split: "test" },
					{ path: mixedFile.toString(), split_attribute: { path: split.attribute } },
				],
			},
			manifest
		)

		const result = await countHoldoutSpans(manifest.toString(), HOLDOUTS)
		const regions = result.counts.filter((count) => count.tag === "region")

		expect(result.filesRead).toBe(3)

		expect(regions.toSorted((a, b) => a.surface.localeCompare(b.surface))).toEqual([
			region("asturias", 0, 2),
			region("cantabria", 1, 0),
			region("illes balears", 0, 1),
			region("madrid", 2, 0, 1, 0),
			region("mallorca", 1, 0, 0, 0),
			region("principado", 1, 0),
		])

		expect(result.postcodes).toEqual([{ country: "ES", prefix: "070", trainRows: 1 }])

		expect(holdoutSpanFindings(result, HOLDOUTS)).toEqual([
			{ country: "ES", reason: "region-key", key: "Illes Balears", trainRows: 0, heldOutRows: 1 },
			{ country: "ES", reason: "locality-in-train", key: "oviedo", trainRows: 1, heldOutRows: 1 },
			{ country: "ES", reason: "postcode-in-train", key: "070", trainRows: 1, heldOutRows: 0 },
		])
	})

	it("refuses a manifest file that records no split", async () => {
		const manifest = root.path("UNSPLIT.json")

		await writeLocalJSONFile({ slices: [{ path: root.path("train.parquet").toString() }] }, manifest)

		await expect(countHoldoutSpans(manifest.toString(), HOLDOUTS)).rejects.toThrow(/neither a split/)
	})
})

describe("holdoutSpanFindings", () => {
	const n = REGION_SURFACE_MIN_ROWS

	it("reports a region whose train share falls far below its country's median, in all rows or without a postcode", () => {
		const counts = [
			// Held out whole.
			region("asturias", 0, n),
			// Keeps its rows with a postcode but loses every row without one.
			region("cantabria", 9 * n, n, 0, n),
			region("madrid", 19 * n, n),
			region("galicia", 19 * n, n),
			region("aragón", 19 * n, n),
			// Below the floor of rows, so not measured.
			region("astrias", 0, 1),
			{ ...region("lisboa", 0, 5 * n), country: "PT" },
		]

		expect(holdoutSpanFindings({ counts, postcodes: [] }, { ES: { postcodePrefixes: ["330"] } })).toEqual([
			{ country: "ES", reason: "region-supply", key: "asturias", trainRows: 0, heldOutRows: n },
			{ country: "ES", reason: "region-supply-without-postcode", key: "asturias", trainRows: 0, heldOutRows: n },
			{ country: "ES", reason: "region-supply-without-postcode", key: "cantabria", trainRows: 0, heldOutRows: n },
		])
	})

	it("reports nothing for a holdout that takes a small part of every region", () => {
		const counts = [region("madrid", 19 * n, n), region("galicia", 18 * n, 2 * n), region("asturias", 20 * n, 0)]

		expect(holdoutSpanFindings({ counts, postcodes: [] }, { ES: { postcodePrefixes: ["330"] } })).toEqual([])
	})
})
