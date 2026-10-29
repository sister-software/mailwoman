/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The GCIS register reader aligns the strings the Python reader aligned, to the same spans, as recorded in
 *   `fixtures/builders/cjk-helpers.json`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

import type { CJKRecord } from "#cjk/builder"
import { unitKey } from "#cjk/builder"
import { alignRegisterAddress, iterTWRegisterRows, TWKeyIndex, twFoldKey, twRegistryRecord } from "#tw/registers"

const RECORD = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "cjk-helpers.json")

interface TWRecord {
	tw_fold_key: Record<string, string>
	tw_align: Record<string, CJKRecord | null>
}

function fixtureIndex(): TWKeyIndex {
	const index = new TWKeyIndex()

	for (const region of ["臺北市", "新北市"]) {
		index.regions.add(region)
	}

	index.districtsByRegion.set("臺北市", new Set(["大安區", "中正區"]))
	index.districtsByRegion.set("新北市", new Set(["板橋區"]))
	index.villagesByUnit.set(unitKey("臺北市", "大安區"), new Set(["錦安里"]))
	index.streetsByUnit.set(unitKey("臺北市", "大安區"), new Set(["和平東路一段", "信義路"]))
	index.streetsByUnit.set(unitKey("臺北市", "中正區"), new Set(["重慶南路一段"]))
	index.streetsByUnit.set(unitKey("新北市", "板橋區"), new Set(["文化路一段"]))

	return index
}

describe("the GCIS register reader", async () => {
	const record = await readLocalJSONFile<TWRecord>(RECORD)

	it("folds keys as the Python reader did", () => {
		for (const [text, key] of Object.entries(record.tw_fold_key)) {
			expect(twFoldKey(text)).toBe(key)
		}
	})

	it("aligns each recorded string to the Python spans, or refuses it", () => {
		const index = fixtureIndex()

		for (const [text, expected] of Object.entries(record.tw_align)) {
			const aligned = alignRegisterAddress(text, index)

			expect(aligned ? twRegistryRecord(aligned) : null, text).toEqual(expected)
		}
	})

	it("names a missing register directory and a missing Overture file", async () => {
		await using scratch = await temporaryDirectory("mailwoman-tw-registers-")
		const directory = scratch.path("gcis-tw").toString()
		const parquet = scratch.path("addresses-tw.parquet").toString()

		await expect(iterTWRegisterRows(directory).next()).rejects.toThrow(directory)
		await expect(TWKeyIndex.fromParquet(parquet)).rejects.toThrow(parquet)
	})
})
