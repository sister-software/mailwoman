/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { describe, expect, it } from "vitest"

import {
	addressLayerFiles,
	addressLayerManifestPath,
	type AddressLayerCountryManifest,
	describeAddressLayerFile,
	planAddressLayerRegions,
	writeAddressLayerManifest,
} from "#address/keys/layout"

describe("planAddressLayerRegions", () => {
	it("writes a country at or below the threshold as one file", () => {
		const counts = new Map<string | null, number>([
			["TW-TXG", 4_000_000],
			[null, 5_700_000],
		])

		expect(planAddressLayerRegions("TW", counts)).toEqual([{ region: "tw", subdivision: null, records: 9_700_000 }])
	})

	it("splits a country above the threshold per subdivision, with unassigned records in the country's file", () => {
		const counts = new Map<string | null, number>([
			["US-WI", 2_394_297],
			["US-TX", 12_089_941],
			[null, 488_379],
		])

		expect(planAddressLayerRegions("US", counts).map(({ region, records }) => `${region}:${records}`)).toEqual([
			"us:488379",
			"us-tx:12089941",
			"us-wi:2394297",
		])
	})

	it("takes the threshold as an option", () => {
		const counts = new Map<string | null, number>([["US-WI", 2_394_297]])

		expect(planAddressLayerRegions("US", counts, 1_000_000)[0]).toMatchObject({ region: "us-wi" })
	})
})

describe("writeAddressLayerManifest", () => {
	it("lists each region's files by relative path, size and SHA-256", async () => {
		await using dir = await temporaryDirectory("address-layout-")

		const files = addressLayerFiles(dir.path, "us-wi", "2026-11-07")

		await writeLocalTextFile("lookup", files.lookup)
		await writeLocalTextFile("detail", files.detail)

		const lookup = await describeAddressLayerFile(dir.path, files.lookup)

		expect(lookup).toEqual({
			path: "addresses/us-wi/2026-11-07/lookup.db",
			bytes: 6,
			sha256: sha256Hex("lookup"),
		})

		const path = await writeAddressLayerManifest(dir.path, {
			country: "US",
			version: "2026-11-07",
			splitRows: 1_000_000,
			regions: [
				{
					region: "us-wi",
					subdivision: "US-WI",
					records: 2,
					lookup,
					detail: await describeAddressLayerFile(dir.path, files.detail),
				},
			],
		})

		const written = await readLocalJSONFile<AddressLayerCountryManifest>(path)

		expect(written.regions[0]?.lookup.path).toBe("addresses/us-wi/2026-11-07/lookup.db")
	})
})

describe("address layer paths", () => {
	it("places each region's files and the country's manifest under a dated prefix", () => {
		const files = addressLayerFiles("/data", "us-wi", "2026-11-07")

		expect(files.lookup.toString()).toBe("/data/addresses/us-wi/2026-11-07/lookup.db")
		expect(files.detail.toString()).toBe("/data/addresses/us-wi/2026-11-07/detail.db")

		expect(addressLayerManifestPath("/data", "US", "2026-11-07").toString()).toBe(
			"/data/addresses/us/2026-11-07/manifest.json"
		)
	})
})
