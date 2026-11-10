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
import { buildUSAddressLayer } from "#us/address-records/layer"

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
})
