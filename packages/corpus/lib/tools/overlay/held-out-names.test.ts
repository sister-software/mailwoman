/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `countHeldOutNameTrainRows` — the train rows that still write each held-out name.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import type { ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { countHeldOutNameTrainRows, heldOutNamePattern } from "#tools/overlay/held-out-names"
import { splitOverlaySlice } from "#tools/overlay/split-slice"
import type { CountryHoldout } from "#utils/split"

const root = await temporaryDirectory("mw-held-out-names-")

afterAll(() => root[Symbol.asyncDispose]())

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

/**
 * An ES row whose last comma-separated part is labeled `region`.
 */
function esRow(sourceID: string, raw: string): ParquetRow {
	const regionStart = raw.lastIndexOf(", ") + 2

	return {
		raw,
		tokens: raw.split(" "),
		labels: raw.split(" ").map(() => "O"),
		span_starts: [regionStart],
		span_ends: [raw.length],
		span_tags: ["region"],
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

const HOLDOUTS: Record<string, CountryHoldout> = { ES: { regions: ["Illes Balears", "Asturias"] } }

describe("countHeldOutNameTrainRows", () => {
	it("reports 0 for a name only held-out rows write, and counts a name another place's row writes", async () => {
		const trainFile = root.path("train.parquet")
		const testFile = root.path("test.parquet")
		const mixedFile = root.path("mixed.parquet")

		// "Asturias" survives in a row whose region is Cantabria; "Illes Balears" is written only by held-out rows.
		await writeParquetFile(
			[esRow("t-1", "Calle Asturias 4, Santander, Cantabria"), esRow("t-2", "Gran Vía 1, Madrid, Madrid")],
			trainFile,
			FIXTURE_DERIVATION
		)

		await writeParquetFile([esRow("x-1", "Palma, Illes Balears")], testFile, FIXTURE_DERIVATION)

		await writeParquetFile(
			[esRow("m-1", "Sóller, Illes Balears"), esRow("m-2", "Oviedo, Asturias"), esRow("m-3", "Toledo, Castilla")],
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

		const result = await countHeldOutNameTrainRows(manifest.toString(), HOLDOUTS)

		expect(result.filesRead).toBe(2)
		expect(result.countryTrainRows).toEqual({ ES: 3 })

		expect(result.counts).toEqual([
			{ country: "ES", kind: "region", name: "Illes Balears", trainRows: 0 },
			{ country: "ES", kind: "region", name: "Asturias", trainRows: 1 },
		])
	})

	it("refuses a manifest file that records no split", async () => {
		const manifest = root.path("UNSPLIT.json")

		await writeLocalJSONFile({ slices: [{ path: root.path("train.parquet").toString() }] }, manifest)

		await expect(countHeldOutNameTrainRows(manifest.toString(), HOLDOUTS)).rejects.toThrow(/neither a split/)
	})
})

describe("heldOutNamePattern", () => {
	it("matches a whole word only, so a region code does not match inside another word", () => {
		const pattern = new RegExp(heldOutNamePattern("NT").replace("(?i)", ""), "iu")

		expect(pattern.test("Darwin NT 0800")).toBe(true)
		expect(pattern.test("Northern Territory, Alice Springs")).toBe(false)
	})
})
