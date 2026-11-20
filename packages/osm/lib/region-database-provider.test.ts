// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { writeLayerManifest, type LayerManifest } from "@mailwoman/core/layers"
import { createAddressPointTable, type AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address/point/schema"
import {
	createSpineAddressPointTables,
	ADDRESS_POINT_H3_RESOLUTION,
	type SpineAddressPointDatabase,
} from "@mailwoman/resolver-wof-sqlite/address/point/spine-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

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
	spineKeys: { h3: { column: "h3_cell", resolution: ADDRESS_POINT_H3_RESOLUTION } },
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

	using db = new DatabaseClient<SpineAddressPointDatabase>(root("address-points-nz-nz.db").toString())

	await createSpineAddressPointTables(db)
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

	it("lists an extract without a layer_manifest table as unread and attaches the others", async () => {
		await using directory = await temporaryDirectory("mw-osm-provider-")

		await dataRootWithExtract(directory)

		const unmanifested = osmDatabaseRoot(directory.path)("address-points-fr-fr.db").toString()

		// The table layout of an extract built before the layer interface, with no `layer_manifest`.
		{
			using db = new DatabaseClient<AddressPointDatabase>(unmanifested)

			await createAddressPointTable(db)
		}

		const admitted: string[] = []

		using provider = await OSMRegionDatabaseProvider.create(directory.path, {
			admit: (manifest) => {
				admitted.push(manifest.name)
			},
		})

		expect(admitted).toEqual([MANIFEST.name])

		expect(provider.unreadExtracts).toEqual([
			{ country: "fr", path: unmanifested, reason: expect.stringMatching(/no layer_manifest table/) },
		])

		expect(provider.for("fr")).toEqual({})
		expect(provider.layerDatabases("fr")).toEqual([])
		expect(provider.for("nz").addressPoints).toBeDefined()
	})

	it("reads no manifest when no admission is set", async () => {
		await using directory = await temporaryDirectory("mw-osm-provider-")

		await dataRootWithExtract(directory)

		using provider = await OSMRegionDatabaseProvider.create(directory.path)

		expect(provider.for("nz").addressPoints).toBeDefined()
		expect(provider.for("fr")).toEqual({})
	})
})
