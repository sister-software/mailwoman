/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A region is built into a layer version once: a build that would rewrite a region's files under a version it
 *   already holds stops before it writes, and its error states the region.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { addressLayerFiles } from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import { describe, expect, it } from "vitest"

import { recordPathFor } from "#parquet/record"
import { buildUSAddressLayer, usAddressSourceRanks } from "#us/address-records/layer"

describe("usAddressSourceRanks", () => {
	// Florida's runs with the levels and dates the 2026-11-10 plan records, plus a city run
	// older than both statewide files and a run whose layer name is outside the level table.
	const rank = usAddressSourceRanks([
		{ member: "us/fl/statewide2", license: false, level: "state", updated: "2022-11-11T13:26:22.320Z" },
		{ member: "us/fl/orange", license: null, level: "county", updated: "2026-10-30T14:54:31.871Z" },
		{ member: "us/fl/statewide", license: false, level: "state", updated: "2020-08-21T06:36:14.690Z" },
		{ member: "us/fl/city_of_miami", license: null, level: "city", updated: "2019-01-01T00:00:00.000Z" },
		{ member: "us/fl/condos", license: null, level: "condos", updated: "2026-11-01T00:00:00.000Z" },
	])

	it("ranks a more local publisher above a statewide file, whatever their job dates", () => {
		expect(rank("openaddresses:us/fl/city_of_miami")).toBeLessThan(rank("openaddresses:us/fl/orange"))
		expect(rank("openaddresses:us/fl/orange")).toBeLessThan(rank("openaddresses:us/fl/statewide2"))
	})

	it("ranks runs of one level newest job first, and a layer name outside the table after every level", () => {
		expect(rank("openaddresses:us/fl/statewide2")).toBeLessThan(rank("openaddresses:us/fl/statewide"))
		expect(rank("openaddresses:us/fl/statewide")).toBeLessThan(rank("openaddresses:us/fl/condos"))
	})

	it("ranks NAD above every run and Overture below every run", () => {
		expect(rank("usgov-nad")).toBeLessThan(rank("openaddresses:us/fl/city_of_miami"))
		expect(rank("overture:us_fl")).toBeGreaterThan(rank("openaddresses:us/fl/condos"))
	})
})

describe("buildUSAddressLayer", () => {
	it("refuses to rebuild a region into a version that already holds it", async () => {
		await using directory = await temporaryDirectory("us-layer-version-")
		const root = directory.path("db")
		const nadParquet = directory.path("nad.parquet").toString()

		await writeLocalJSONFile({ rowsByState: { TX: 1 } }, recordPathFor(nadParquet))
		await writeLocalFile("", addressLayerFiles(root, "us-tx", "2026-11-10").lookup)

		await expect(
			buildUSAddressLayer({
				root,
				version: "2026-11-10",
				nadParquet,
				overtureParquet: directory.path("overture.parquet"),
				openAddresses: { plan: [], cache: directory.path("oa-cache") },
				states: ["TX"],
				buildSHA: "test",
				adminDatabase: directory.path("admin.db"),
			})
		).rejects.toThrow("us-tx already built in 2026-11-10; build into a new version")
	})

	it("stops when the plan lists runs and the cache directory is absent, as an unmounted volume leaves it", async () => {
		await using directory = await temporaryDirectory("us-layer-cache-")
		const nadParquet = directory.path("nad.parquet").toString()

		await writeLocalJSONFile({ rowsByState: { TX: 1 } }, recordPathFor(nadParquet))

		await expect(
			buildUSAddressLayer({
				root: directory.path("db"),
				version: "2026-11-12",
				nadParquet,
				overtureParquet: directory.path("overture.parquet"),
				openAddresses: {
					plan: [{ member: "us/tx/nueces", license: null }],
					cache: directory.path("oa-cache"),
				},
				states: ["TX"],
				buildSHA: "test",
				adminDatabase: directory.path("admin.db"),
			})
		).rejects.toThrow("does not exist; if it is on a separate volume, mount it before building")
	})
})
