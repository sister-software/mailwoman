// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { LayerManifest } from "@mailwoman/core/layers"
import { ObligationRefusal } from "@mailwoman/license/refusals"
import { describe, expect, it } from "vitest"

import { assertLayerObligationsAccepted } from "#data"

describe("assertLayerObligationsAccepted", () => {
	const manifest: LayerManifest = {
		name: "osm-address-points-nz-nz",
		version: "260806",
		schemaVersion: 1,
		tier: "build-local",
		license: "ODbL-1.0",
		attribution: "© OpenStreetMap contributors",
		source: "openstreetmap:nz",
		sourceVintage: "2026-08-06",
		buildCmd: "node packages/osm/tools/build-rooftop-database.ts",
		buildSHA: "fixture",
		freshnessPolicy: "sealed",
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: "2026-08-07T00:00:00.000Z",
		sourceRecords: null,
		sourceURL: "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
		sourceSHA256: "d".repeat(64),
	}

	const path = "/data/db/osm/address-points-nz-nz.db"

	it("refuses an ODbL layer under a share-alike refusal and repeats its provenance in the message", () => {
		const refuse = () => assertLayerObligationsAccepted(manifest, path, [ObligationRefusal.ShareAlike])

		expect(refuse).toThrow(/ODbL-1\.0 carries share-alike/)
		expect(refuse).toThrow(/osm-address-points-nz-nz at \/data\/db\/osm\/address-points-nz-nz\.db/)
		expect(refuse).toThrow(/credit © OpenStreetMap contributors/)
		expect(refuse).toThrow(/new-zealand-latest\.osm\.pbf sha256 d{64}/)
	})

	it("accepts the layer when no refused class applies", () => {
		expect(() => assertLayerObligationsAccepted(manifest, path, [])).not.toThrow()
		expect(() => assertLayerObligationsAccepted(manifest, path, [ObligationRefusal.Unresolved])).not.toThrow()
	})
})
