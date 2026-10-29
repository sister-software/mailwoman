/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The corporate-number register reader aligns the rows the Python reader aligned, to the same spans, as
 *   recorded in `fixtures/builders/cjk-helpers.json`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

import { type CJKRecord, unitKey } from "#cjk/builder"
import { alignCorporateRow, type CorporateRow, iterCorporateRows, JPKeyIndex, jpRegistryRecord } from "#jp/registers"

const RECORD = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "cjk-helpers.json")

interface JPRecord {
	jp_align: Array<[street: string, withPostcode: boolean, record: CJKRecord | null]>
}

const ROWS: CorporateRow[] = [
	["東京都", "千代田区", "霞が関３丁目１番１号", "1000013"],
	["東京都", "千代田区", "一番町１８４ ビル名 ３Ｆ", "1020082"],
	["北海道", "札幌市中央区", "一条通北２丁目３－２５", "12345"],
	["東京都", "港区", "芝公園４丁目", "1050011"],
	["東京都", "千代田区", "永田町１", "1000014"],
].map(([prefecture, municipality, street, postcode]) => ({
	name: "x",
	kind: "301",
	prefecture: prefecture!,
	municipality: municipality!,
	street: street!,
	postcode: postcode!,
}))

describe("the corporate-number register reader", async () => {
	const record = await readLocalJSONFile<JPRecord>(RECORD)

	it("aligns each recorded row to the Python spans, with and without a postcode, or refuses it", () => {
		const index = new JPKeyIndex()

		index.districtsByUnit.set(unitKey("東京都", "千代田区"), new Set(["霞が関", "一番町"]))
		index.districtsByUnit.set(unitKey("北海道", "札幌市中央区"), new Set(["一条通北"]))

		const observed = ROWS.flatMap((row) =>
			[false, true].map((withPostcode) => {
				const aligned = alignCorporateRow(row, index, withPostcode)

				return [row.street, withPostcode, aligned ? jpRegistryRecord(aligned) : null]
			})
		)

		expect(observed).toEqual(record.jp_align)
	})

	it("names a missing register zip and a missing Overture file", async () => {
		await using scratch = await temporaryDirectory("mailwoman-jp-registers-")
		const zip = scratch.path("00_zenkoku_all.zip").toString()
		const parquet = scratch.path("addresses-jp.parquet").toString()

		await expect(iterCorporateRows(zip).next()).rejects.toThrow(zip)
		await expect(JPKeyIndex.fromParquet(parquet)).rejects.toThrow(parquet)
	})
})
