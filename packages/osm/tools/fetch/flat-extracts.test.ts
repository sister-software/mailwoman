// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { setTimestamps, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { extractReceiptPath } from "#sdk/extract/receipt"
import { resolveGeofabrikExtract } from "#sdk/geofabrik/snapshot"
import { applyFlatExtractMove, planFlatExtractMove, RegionBasis, VintageBasis } from "#tools/fetch/flat-extracts"

/**
 * A flat directory with one file of each kind: dated with a receipt,
 * `-latest` with none, and dated with none.
 */
async function writeFlatFixture(flat: PathBuilder): Promise<void> {
	await writeLocalTextFile("georgia bytes", flat("georgia-261016.osm.pbf"))

	await writeLocalJSONFile(
		{
			region: "europe/georgia",
			source_url: "https://download.geofabrik.de/europe/georgia-latest.osm.pbf",
			retrieved_at: "2026-10-17T21:24:53.150Z",
			last_modified: "Fri, 16 Oct 2026 23:56:31 GMT",
			filename: "georgia-261016.osm.pbf",
		},
		extractReceiptPath(flat("georgia-261016.osm.pbf"))
	)

	await writeLocalTextFile("hungary bytes", flat("hungary-latest.osm.pbf"))
	const modified = new Date("2026-07-05T08:43:00Z")

	await setTimestamps(flat("hungary-latest.osm.pbf"), modified, modified)
	await writeLocalTextFile("germany bytes", flat("germany-260806.osm.pbf"))
}

describe("planFlatExtractMove", () => {
	it("dates each kind of flat file and changes no file", async () => {
		await using directory = await temporaryDirectory("mw-osm-flat-")
		const flat = directory.path("flat")
		const snapshots = directory.path("snapshots")

		await writeFlatFixture(flat)

		const before = await sortedGlob(directory.path, "**/*")
		const moves = await planFlatExtractMove(flat, snapshots, new Map([["hungary", "europe/hungary"]]))

		expect(await sortedGlob(directory.path, "**/*")).toEqual(before)

		expect(
			moves.map(({ leaf, vintage, vintageBasis, region, regionBasis, blocked }) => ({
				leaf,
				vintage,
				vintageBasis,
				region,
				regionBasis,
				blocked,
			}))
		).toEqual([
			{
				leaf: "georgia",
				vintage: "2026-10-16",
				vintageBasis: VintageBasis.receipt,
				region: "europe/georgia",
				regionBasis: RegionBasis.receipt,
				blocked: null,
			},
			{
				leaf: "germany",
				vintage: "2026-08-06",
				vintageBasis: VintageBasis.fileName,
				region: "europe/germany",
				regionBasis: RegionBasis.registry,
				blocked: null,
			},
			{
				leaf: "hungary",
				vintage: "2026-07-05",
				vintageBasis: VintageBasis.modificationTime,
				region: "europe/hungary",
				regionBasis: RegionBasis.caller,
				blocked: null,
			},
		])
	})
})

describe("applyFlatExtractMove", () => {
	it("moves each file with its receipt into a vintage the readers resolve", async () => {
		await using directory = await temporaryDirectory("mw-osm-flat-")
		const flat = directory.path("flat")
		const snapshots = directory.path("snapshots")

		await writeFlatFixture(flat)

		const moves = await planFlatExtractMove(flat, snapshots, new Map([["hungary", "europe/hungary"]]))

		await applyFlatExtractMove(moves, snapshots)

		expect(await sortedGlob(flat, "*")).toEqual([])

		const georgia = await resolveGeofabrikExtract("europe/georgia", { snapshotRoot: snapshots })

		expect(georgia.vintage).toBe("2026-10-16")

		expect(await sortedGlob(directory.path("snapshots", "geofabrik", "europe", "georgia", "2026-10-16"), "*")).toEqual([
			georgia.path.toString(),
			extractReceiptPath(georgia.path),
		])

		await expect(resolveGeofabrikExtract("europe/hungary", { snapshotRoot: snapshots })).resolves.toMatchObject({
			vintage: "2026-07-05",
		})
	})
})
