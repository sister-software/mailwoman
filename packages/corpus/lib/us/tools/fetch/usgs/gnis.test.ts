// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { APIClient } from "@mailwoman/core/api"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { silentLogger } from "@mailwoman/core/logging"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { useScratchDir } from "#test-kit"
import {
	downloadUSGSGNIS,
	type GNISPopulatedPlace,
	normalizeGNISFeature,
	USGS_GNIS_PLACES_FILENAME,
	type USGSGNISManifest,
} from "#us/tools/fetch/usgs/gnis"

const scratch = useScratchDir("usgs-gnis-fetch")

const SERVICE = {
	copyrightText: "USGS The National Map: Geographic Names Information System. Data Refreshed October, 2026.",
}

// Cherokee, Texas, as the service answers it: a one-point multipoint under lower-case field names.
const CHEROKEE = {
	type: "Feature",
	geometry: { type: "MultiPoint", coordinates: [[-98.7086, 30.9796]] },
	properties: {
		OBJECTID: 41,
		gaz_id: 1_332_993,
		gaz_name: "Cherokee",
		gaz_featureclass: "Populated Place",
		fcode: null,
		state_alpha: "TX",
		county_name: "San Saba",
		incounty_id: 1_383_989,
		isunknowncoords: 0,
	},
}

const UNPLACED = {
	type: "Feature",
	geometry: null,
	properties: { OBJECTID: 42, gaz_id: 1, gaz_name: "Nowhere", state_alpha: "tx", isunknowncoords: 1 },
}

function stubClient(results: StubResult[]): APIClient {
	return new APIClient({
		displayName: "usgs gnis test",
		logger: silentLogger(),
		axios: stubTransport(results).axios,
	})
}

describe("normalizeGNISFeature", () => {
	it("reads the multipoint's point and the layer's fields", () => {
		expect(normalizeGNISFeature(CHEROKEE)).toEqual({
			gnisID: 1_332_993,
			name: "Cherokee",
			featureClass: "Populated Place",
			fcode: null,
			state: "TX",
			county: "San Saba",
			countyGNISID: 1_383_989,
			unknownCoordinates: false,
			longitude: -98.7086,
			latitude: 30.9796,
		} satisfies GNISPopulatedPlace)
	})

	it("keeps a place with no geometry, with its point unknown and its state upper-cased", () => {
		expect(normalizeGNISFeature(UNPLACED)).toMatchObject({
			state: "TX",
			unknownCoordinates: true,
			longitude: null,
			latitude: null,
		})
	})

	it("refuses a feature with no GNIS id", () => {
		expect(() => normalizeGNISFeature({ type: "Feature", properties: { gaz_name: "X" } })).toThrow(/no GNIS id/)
	})
})

describe("downloadUSGSGNIS", () => {
	it("writes each place as one line and records the count and the publisher's refresh", async () => {
		const client = stubClient([
			{ body: SERVICE },
			{ body: { count: 2 } },
			{ body: { type: "FeatureCollection", features: [CHEROKEE, UNPLACED] } },
		])

		await downloadUSGSGNIS(client, { outputDir: scratch.path })

		const written = await Array.fromAsync(
			JSONSpliterator.fromAsync<GNISPopulatedPlace>(scratch.path(USGS_GNIS_PLACES_FILENAME))
		)

		expect(written.map((place) => place.gnisID)).toEqual([1_332_993, 1])

		const manifest = await readLocalJSONFile<USGSGNISManifest>(scratch.path("MANIFEST.json"))

		expect(manifest.feature_count).toBe(written.length)
		expect(manifest.publisher_version).toBe(SERVICE.copyrightText)
	})
})
