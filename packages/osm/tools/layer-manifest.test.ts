import { readLayerManifest, writeLayerManifest } from "@mailwoman/core/layers"
import { summarizeLicense } from "@mailwoman/core/license/obligations"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { createOSMAddressPointTables, type OSMAddressPointDatabase } from "#address-point-schema"
import { OSM_ATTRIBUTION, OSM_LICENSE } from "#license"
import { osmAddressPointLayerManifest, type OSMAddressPointBuild } from "#tools/layer-manifest"

const BUILD: OSMAddressPointBuild = {
	country: "nz",
	slug: "nz",
	release: "260806",
	createdAt: "2026-08-07T00:00:00.000Z",
	buildSHA: "0123456789abcdef0123456789abcdef01234567",
	buildCmd: "node packages/osm/tools/build-rooftop-database.ts",
	provenance: {
		sourceURL: "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
		sourceSHA256: "b".repeat(64),
		snapshotDate: "2026-08-06",
	},
}

describe("osmAddressPointLayerManifest", () => {
	it("records the license, credit, extract URL and digest, snapshot date and build revision in the sealed row", async () => {
		using db = DatabaseClient.temp<OSMAddressPointDatabase>()

		await createOSMAddressPointTables(db)
		await writeLayerManifest(db, osmAddressPointLayerManifest(BUILD))

		const manifest = await readLayerManifest(db)

		expect(manifest).toMatchObject({
			name: "osm-address-points-nz-nz",
			tier: "build-local",
			license: OSM_LICENSE,
			attribution: OSM_ATTRIBUTION,
			source: "openstreetmap:nz",
			sourceVintage: "2026-08-06",
			sourceURL: BUILD.provenance.sourceURL,
			sourceSHA256: BUILD.provenance.sourceSHA256,
			buildSHA: BUILD.buildSHA,
		})

		// The doctor and `data bom` summarize this expression, and share-alike is what they report.
		expect(summarizeLicense(manifest.license).obligations).toEqual(["attribution", "share_alike"])
	})

	it("falls back to the release tag for the vintage when the extract had no receipt", () => {
		const manifest = osmAddressPointLayerManifest({
			...BUILD,
			provenance: { ...BUILD.provenance, snapshotDate: null },
		})

		expect(manifest.sourceVintage).toBe("260806")
		expect(manifest.sourceURL).toBe(BUILD.provenance.sourceURL)
	})
})
