/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `admitParquetManifest`: the held-out span check as the step that moves a staged parquet manifest into place.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import {
	admitParquetManifest,
	HOLDOUT_CHECK_FILE,
	type HoldoutCheckRecord,
	PARQUET_MANIFEST_FILE,
	UNCHECKED_PARQUET_MANIFEST_FILE,
} from "#build/holdout-check"
import type { ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import type { CountryHoldout } from "#utils/split"

const root = await temporaryDirectory("mw-holdout-check-")

afterAll(() => root[Symbol.asyncDispose]())

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

/**
 * An ES row `<street>, <locality>, <region>` with the locality and region labeled.
 */
function esRow(sourceID: string, raw: string): ParquetRow {
	const regionStart = raw.lastIndexOf(", ") + 2
	const localityStart = raw.lastIndexOf(", ", regionStart - 3) + 2

	return {
		raw,
		tokens: raw.split(" "),
		labels: raw.split(" ").map(() => "O"),
		span_starts: [localityStart, regionStart],
		span_ends: [regionStart - 2, raw.length],
		span_tags: ["locality", "region"],
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

const HOLDOUTS: Record<string, CountryHoldout> = { ES: { localities: ["Oviedo"] } }

/**
 * Stages a corpus directory whose train file holds `trainRows` and whose test file
 * holds `testRows`, with the parquet manifest under its unchecked name.
 */
async function stageCorpus(name: string, trainRows: ParquetRow[], testRows: ParquetRow[]) {
	const corpusDir = root.path(name)
	const trainFile = corpusDir("train.parquet")
	const testFile = corpusDir("test.parquet")

	await makeDirectories(corpusDir)
	await writeParquetFile(trainRows, trainFile, FIXTURE_DERIVATION)
	await writeParquetFile(testRows, testFile, FIXTURE_DERIVATION)

	await writeLocalJSONFile(
		{
			slices: [
				{ path: trainFile.toString(), split: "train" },
				{ path: testFile.toString(), split: "test" },
			],
		},
		corpusDir(UNCHECKED_PARQUET_MANIFEST_FILE)
	)

	return corpusDir
}

describe("admitParquetManifest", () => {
	it("moves the staged manifest into place and writes an admitted receipt when the check finds nothing", async () => {
		const corpusDir = await stageCorpus(
			"admitted",
			[esRow("t-1", "Calle 1, Gijón, Asturias"), esRow("t-2", "Gran Vía 1, Madrid, Madrid")],
			[esRow("x-1", "Calle 3, Oviedo, Asturias")]
		)

		const record = await admitParquetManifest({ corpusDir, holdouts: HOLDOUTS })

		expect(record.admitted).toBe(true)
		expect(record.countries).toEqual(["ES"])
		expect(record.files_read).toBe(2)
		expect(record.findings).toEqual([])

		expect(await pathExists(corpusDir(PARQUET_MANIFEST_FILE))).toBe(true)
		expect(await pathExists(corpusDir(UNCHECKED_PARQUET_MANIFEST_FILE))).toBe(false)

		const receipt = await readLocalJSONFile<HoldoutCheckRecord>(corpusDir(HOLDOUT_CHECK_FILE))

		expect(receipt).toEqual(record)
	})

	it("leaves the manifest under its unchecked name, writes the findings and throws when a held-out place trains", async () => {
		const corpusDir = await stageCorpus(
			"refused",
			[esRow("t-1", "Calle 5, Oviedo, Asturias"), esRow("t-2", "Gran Vía 1, Madrid, Madrid")],
			[esRow("x-1", "Calle 3, Oviedo, Asturias")]
		)

		await expect(admitParquetManifest({ corpusDir, holdouts: HOLDOUTS })).rejects.toThrow(
			/held-out span check refused the corpus.*ES locality-in-train oviedo: 1 train rows, 1 held out/su
		)

		expect(await pathExists(corpusDir(PARQUET_MANIFEST_FILE))).toBe(false)
		expect(await pathExists(corpusDir(UNCHECKED_PARQUET_MANIFEST_FILE))).toBe(true)

		const receipt = await readLocalJSONFile<HoldoutCheckRecord>(corpusDir(HOLDOUT_CHECK_FILE))

		expect(receipt.admitted).toBe(false)

		expect(receipt.findings).toEqual([
			{ country: "ES", reason: "locality-in-train", key: "oviedo", trainRows: 1, heldOutRows: 1 },
		])
	})

	it("checks an already admitted manifest in place, so a resumed build reports the same receipt", async () => {
		const corpusDir = await stageCorpus(
			"resumed",
			[esRow("t-1", "Calle 1, Gijón, Asturias")],
			[esRow("x-1", "Calle 3, Oviedo, Asturias")]
		)

		await admitParquetManifest({ corpusDir, holdouts: HOLDOUTS })

		const again = await admitParquetManifest({ corpusDir, holdouts: HOLDOUTS })

		expect(again.admitted).toBe(true)
		expect(await pathExists(corpusDir(PARQUET_MANIFEST_FILE))).toBe(true)
	})
})
