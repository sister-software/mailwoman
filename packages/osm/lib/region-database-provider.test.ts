import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { writeLayerManifest, type LayerManifest } from "@mailwoman/core/layers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import {
	createOSMAddressPointTables,
	OSM_ADDRESS_H3_RESOLUTION,
	type OSMAddressPointDatabase,
} from "#address-point-schema"
import { OSM_ATTRIBUTION, OSM_LICENSE } from "#license"
import { osmDatabaseRoot } from "#paths"
import { OSMRegionDatabaseProvider } from "#region-database-provider"

const MANIFEST: LayerManifest = {
	name: "osm-address-points-nz-nz",
	version: "fixture",
	schemaVersion: 1,
	tier: "build-local",
	license: OSM_LICENSE,
	attribution: OSM_ATTRIBUTION,
	source: "openstreetmap:nz",
	sourceVintage: "2026-08-06",
	buildCmd: "fixture",
	buildSHA: "fixture",
	freshnessPolicy: "sealed",
	spineKeys: { h3: { column: "h3_cell", resolution: OSM_ADDRESS_H3_RESOLUTION } },
	createdAt: "2026-08-07T00:00:00.000Z",
	sourceRecords: null,
	sourceURL: "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
	sourceSHA256: "c".repeat(64),
}

/**
 * A data root holding one New Zealand extract with {@link MANIFEST} and no rows.
 */
async function dataRootWithExtract(directory: Awaited<ReturnType<typeof temporaryDirectory>>): Promise<void> {
	const root = osmDatabaseRoot(directory.path)

	await makeDirectories(root)

	using db = new DatabaseClient<OSMAddressPointDatabase>(root("address-points-nz-nz.db").toString())

	await createOSMAddressPointTables(db)
	await writeLayerManifest(db, MANIFEST)
}

describe("OSMRegionDatabaseProvider admission", () => {
	it("passes each on-disk extract's manifest to admit and attaches the extracts it accepts", async () => {
		await using directory = await temporaryDirectory("mw-osm-provider-")

		await dataRootWithExtract(directory)

		const seen: Array<{ name: string; license: string; sourceSHA256: string | null | undefined }> = []

		using provider = await OSMRegionDatabaseProvider.create(directory.path, {
			admit: (manifest) => {
				seen.push({ name: manifest.name, license: manifest.license, sourceSHA256: manifest.sourceSHA256 })
			},
		})

		expect(seen).toEqual([{ name: MANIFEST.name, license: OSM_LICENSE, sourceSHA256: MANIFEST.sourceSHA256 }])
		expect(provider.for("NZ").addressPoints).toBeDefined()
	})

	it("propagates the refusal admit throws instead of answering as if the country had no extract", async () => {
		await using directory = await temporaryDirectory("mw-osm-provider-")

		await dataRootWithExtract(directory)

		await expect(
			OSMRegionDatabaseProvider.create(directory.path, {
				admit: (manifest, path) => {
					throw new Error(`refused ${manifest.license} at ${path}`)
				},
			})
		).rejects.toThrow(/refused ODbL-1\.0 at .*address-points-nz-nz\.db/)
	})

	it("reads no manifest when no admission is set", async () => {
		await using directory = await temporaryDirectory("mw-osm-provider-")

		await dataRootWithExtract(directory)

		using provider = await OSMRegionDatabaseProvider.create(directory.path)

		expect(provider.for("nz").addressPoints).toBeDefined()
		expect(provider.for("fr")).toEqual({})
	})
})
