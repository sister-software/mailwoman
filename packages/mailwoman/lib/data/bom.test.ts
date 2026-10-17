/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { buildDataBOM, LicenseBasis } from "#data/bom"
import { Provenance, type InventoryReport } from "#data/inventory"

const OSM_PATH = "db/osm/address-points-nz-nz.db"

const INVENTORY: InventoryReport = {
	dataRoot: "/data",
	entries: [
		{
			path: OSM_PATH,
			bytes: 412_000_000,
			provenance: Provenance.Manifested,
			manifest: {
				name: "osm-address-points-nz-nz",
				version: "260806",
				tier: "build-local",
				license: "ODbL-1.0",
				attribution: "© OpenStreetMap contributors",
				source: "openstreetmap:nz",
				source_vintage: "2026-08-06",
				build_cmd: "node packages/osm/tools/build-rooftop-database.ts",
				build_sha: "0123456789abcdef0123456789abcdef01234567",
				created_at: "2026-08-07T00:00:00.000Z",
				source_url: "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
				source_sha256: "e".repeat(64),
			},
		},
	],
	counts: {
		[Provenance.Manifested]: 1,
		[Provenance.Unprovenanced]: 0,
		[Provenance.Foreign]: 0,
		[Provenance.Unreadable]: 0,
	},
	skippedForeign: 0,
	maxDepth: 4,
}

describe("buildDataBOM over a locally built OpenStreetMap layer", () => {
	it("records the layer's own license expression, credit and input file beside the release's bundles", () => {
		const document = buildDataBOM({
			mailwomanVersion: "10.6.0",
			snapshot: { measuredAt: "2026-10-17T00:00:00.000Z", bucket: "https://example.org/", bundles: [] },
			inventory: INVENTORY,
		})

		const component = document.components.find((entry) => entry.name === OSM_PATH)

		expect(component?.licenses).toEqual([{ expression: "ODbL-1.0" }])

		const properties = Object.fromEntries((component?.properties ?? []).map((entry) => [entry.name, entry.value]))

		expect(properties).toMatchObject({
			"mailwoman:licenseBasis": LicenseBasis.ArtifactManifest,
			"mailwoman:tier": "build-local",
			"mailwoman:attribution": "© OpenStreetMap contributors",
			"mailwoman:source": "openstreetmap:nz",
			"mailwoman:sourceURL": "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
			"mailwoman:sourceSHA256": "e".repeat(64),
		})

		// The layer is reported independently: no bundle component claims its path.
		expect(document.components.filter((entry) => entry.name === OSM_PATH)).toHaveLength(1)
	})
})
