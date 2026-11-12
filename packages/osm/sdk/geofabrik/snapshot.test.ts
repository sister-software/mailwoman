// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { geofabrikExtractPath, geofabrikSnapshotDirectory } from "#paths"
import { resolveGeofabrikExtract } from "#sdk/geofabrik/snapshot"

const REGION = "europe/germany"

describe("resolveGeofabrikExtract", () => {
	it("reads the newest vintage that holds the extract, ignoring a staging directory", async () => {
		await using directory = await temporaryDirectory("mw-osm-snapshot-")
		const root = directory.path

		await writeLocalTextFile("older", geofabrikExtractPath(REGION, "2026-08-06", root))
		await writeLocalTextFile("newer", geofabrikExtractPath(REGION, "2026-10-17", root))

		await writeLocalTextFile(
			"partial",
			geofabrikSnapshotDirectory(REGION, root)("2026-11-01.staging-1", "germany.osm.pbf")
		)

		const resolved = await resolveGeofabrikExtract(REGION, { snapshotRoot: root })

		expect(resolved.vintage).toBe("2026-10-17")
		expect(resolved.path.toString()).toBe(geofabrikExtractPath(REGION, "2026-10-17", root).toString())
	})

	it("reads a stated vintage, and refuses one that holds no extract", async () => {
		await using directory = await temporaryDirectory("mw-osm-snapshot-")
		const root = directory.path

		await writeLocalTextFile("older", geofabrikExtractPath(REGION, "2026-08-06", root))
		await writeLocalTextFile("newer", geofabrikExtractPath(REGION, "2026-10-17", root))

		await expect(resolveGeofabrikExtract(REGION, { vintage: "2026-08-06", snapshotRoot: root })).resolves.toMatchObject(
			{
				vintage: "2026-08-06",
			}
		)

		await expect(resolveGeofabrikExtract(REGION, { vintage: "2026-09-01", snapshotRoot: root })).rejects.toThrow(
			/no extract in vintage 2026-09-01/
		)
	})

	it("refuses a region with no vintage rather than reading another directory", async () => {
		await using directory = await temporaryDirectory("mw-osm-snapshot-")

		await expect(resolveGeofabrikExtract(REGION, { snapshotRoot: directory.path })).rejects.toThrow(/holds no vintage/)
	})
})
