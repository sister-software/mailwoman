// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Drives the structures fetcher through the real `APIClient` over a stubbed transport.
 *
 *   The features are ones the USGS structures MapServer served on 2026-11-09
 *   and 2026-11-13, in the service's upper-case field spelling.
 *   The service text is what its MapServer description stated on 2026-11-11.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { silentLogger } from "@mailwoman/core/logging"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { useScratchDir } from "#test-kit"
import { USGS_STRUCTURES_FILENAME, type USGSStructureFeature } from "#us/adapters/usgov/usgs-structures/adapter"
import { usgsStructureLayer } from "#us/structures/usgs/layers"
import {
	downloadUSGSStructures,
	normalizeStructureFeature,
	structureZIPCode,
	type USGSStructuresManifest,
} from "#us/tools/fetch/usgs-structures"

const scratch = useScratchDir("usgs-structures-fetch")

const SERVICE = {
	copyrightText: "USGS TNM – National Structures Dataset. Data Refreshed October, 2026.",
	serviceDescription: "The National Map download client allows free downloads of public domain structures data",
}

const POST_OFFICES = usgsStructureLayer(38)
const COLLEGES = usgsStructureLayer(56)

function serviceFeature(
	objectID: number,
	id: string,
	name: string,
	address: string,
	city: string,
	state: string,
	zipcode: string | number,
	coordinates: [number, number]
) {
	return {
		type: "Feature",
		id: objectID,
		geometry: { type: "Point", coordinates },
		properties: {
			OBJECTID: objectID,
			PERMANENT_IDENTIFIER: id,
			NAME: name,
			ADDRESS: address,
			CITY: city,
			STATE: state,
			ZIPCODE: zipcode,
		},
	}
}

const PALM_BAY = serviceFeature(
	6_540_874,
	"0087eaa9-8730-40a8-9733-23eaffb0afbb",
	"Palm Bay West Post Office",
	"950 Malabar Road Southwest",
	"Palm Bay",
	"FL",
	"32907",
	[-80.69800307551182, 27.998160830234198]
)

const CAGUAS = serviceFeature(
	6_540_901,
	"09da8555-c417-407d-8f43-732d68559157",
	"North Post Office",
	"555 Calle Munoz Rivera",
	"Caguas",
	"PR",
	"00725",
	[-66.03415442360408, 18.236371487178346]
)

const LAKEVILLE = serviceFeature(
	6_540_919,
	"00689248-e551-41f1-b718-d34eb284db3b",
	"Lakeville Post Office",
	"339 Main Street",
	"Lakeville",
	"CT",
	"06039-9992",
	[-73.44045391998858, 41.96564954032993]
)

const BETHANY = {
	type: "Feature",
	id: 6_415_843,
	geometry: { type: "Point", coordinates: [-97.67374919089188, 38.579165486897814] },
	properties: {
		objectid: 6_415_843,
		permanent_identifier: "06d7db6c-b514-436e-a87b-1978e13aa6e3",
		source_originator: "U.S. Geological Survey",
		loaddate: 1_705_536_000_000,
		fcode: 73_006,
		name: "Bethany College",
		addressbuildingname: null,
		address: "335 East Swensson Street",
		city: "Lindsborg",
		state: "KS",
		zipcode: "67456",
		gnis_id: "482715",
	},
}

const page = (...features: unknown[]): StubResult => ({ body: { type: "FeatureCollection", features } })

function stubClient(results: StubResult[]): APIClient & { calls: string[] } {
	const transport = stubTransport(results)

	const client = new APIClient({
		displayName: "usgs structures test",
		logger: silentLogger(),
		axios: transport.axios,
	})

	return Object.assign(client, { calls: transport.calls })
}

async function readWritten(): Promise<USGSStructureFeature[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<USGSStructureFeature>(scratch.path(USGS_STRUCTURES_FILENAME)))
}

describe("structureZIPCode", () => {
	it("restores the leading zeros a numeric Puerto Rico ZIP Code lost, and keeps the published value", () => {
		expect(structureZIPCode(725, "PR")).toEqual({ zipcode: "00725", zipcode_published: "725" })
	})

	it("keeps a five-digit ZIP Code and a ZIP+4 as published", () => {
		expect(structureZIPCode("00907", "PR")).toEqual({ zipcode: "00907" })
		expect(structureZIPCode("06039-9992", "CT")).toEqual({ zipcode: "06039-9992" })
	})

	it("reads a value that is no ZIP Code for its state as null, and keeps what was published", () => {
		expect(structureZIPCode("7341", "TX")).toEqual({ zipcode: null, zipcode_published: "7341" })
	})

	it("keeps the trimmed value where the state is not one the codex knows", () => {
		expect(structureZIPCode(" 96940 ", "PW")).toEqual({ zipcode: "96940" })
		expect(structureZIPCode(null, "FL")).toEqual({ zipcode: null })
	})
})

describe("normalizeStructureFeature", () => {
	it("lower-cases the service's field names, stamps the layer, and keeps the point", () => {
		expect(normalizeStructureFeature(BETHANY, COLLEGES)).toEqual({
			type: "Feature",
			geometry: { type: "Point", coordinates: [-97.67374919089188, 38.579165486897814] },
			properties: {
				layer_id: 56,
				layer: "colleges-universities",
				objectid: 6_415_843,
				permanent_identifier: "06d7db6c-b514-436e-a87b-1978e13aa6e3",
				fcode: 73_006,
				gnis_id: "482715",
				name: "Bethany College",
				addressbuildingname: null,
				address: "335 East Swensson Street",
				city: "Lindsborg",
				state: "KS",
				zipcode: "67456",
				loaddate: "2024-01-18",
				source_originator: "U.S. Geological Survey",
			},
		})
	})

	it("refuses a value that is not a GeoJSON feature, and a feature with no OBJECTID", () => {
		expect(() => normalizeStructureFeature({ type: "FeatureCollection" }, COLLEGES)).toThrow(
			/expected a GeoJSON Feature/
		)

		expect(() => normalizeStructureFeature({ type: "Feature", properties: {} }, COLLEGES)).toThrow(/no OBJECTID/)
	})
})

describe("downloadUSGSStructures", () => {
	it("counts each layer, pages it by OBJECTID, and writes every feature with per-layer counts", async () => {
		const client = stubClient([
			{ body: SERVICE },
			{ body: { count: 3 } },
			page(PALM_BAY, CAGUAS),
			page(LAKEVILLE),
			{ body: { count: 1 } },
			page(BETHANY),
		])

		// A page of two stands in for the service's 2,000, so the second request starts after the second OBJECTID.
		const summary = await downloadUSGSStructures(client, { outputDir: scratch.path, layers: [POST_OFFICES, COLLEGES] })

		expect(summary).toEqual({ fetched: 1, skipped: 0, failed: 0, failedCodes: [] })
		expect(client.calls).toHaveLength(6)
		expect(client.calls[1]).toContain("/38/query?")
		expect(client.calls[1]).toContain("returnCountOnly=true")
		expect(client.calls[2]).toContain(`where=${encodeURIComponent("OBJECTID>0")}`)
		expect(client.calls[3]).toContain(`where=${encodeURIComponent(`OBJECTID>${CAGUAS.id}`)}`)
		expect(client.calls[4]).toContain("/56/query?")
		expect(client.calls.slice(2).every((url) => !url.includes("resultOffset"))).toBe(true)

		const written = await readWritten()

		expect(written.map((feature) => feature.properties.layer)).toEqual([
			"post-offices",
			"post-offices",
			"post-offices",
			"colleges-universities",
		])

		expect(written.map((feature) => feature.properties.zipcode)).toEqual(["32907", "00725", "06039-9992", "67456"])

		const manifest = await readLocalJSONFile<USGSStructuresManifest>(scratch.path("MANIFEST.json"))

		expect(manifest.feature_count).toBe(written.length)

		expect(manifest.layers.map((layer) => [layer.layer_id, layer.feature_count])).toEqual([
			[38, 3],
			[56, 1],
		])

		expect(manifest.publisher_version).toBe(SERVICE.copyrightText)
		expect(manifest.filename).toBe(USGS_STRUCTURES_FILENAME)

		expect(await readLocalJSONFile(scratch.path("service.json"))).toEqual(SERVICE)
	})

	it("refuses a pull that holds fewer features than the service counted, and writes no feature file", async () => {
		const client = stubClient([{ body: SERVICE }, { body: { count: 3 } }, page(PALM_BAY, CAGUAS), page()])

		await expect(downloadUSGSStructures(client, { outputDir: scratch.path, layers: [POST_OFFICES] })).rejects.toThrow(
			/counted 3 features in layer 38 and the pull returned 2/
		)

		expect(await pathExists(scratch.path(USGS_STRUCTURES_FILENAME))).toBe(false)
	})

	it("refuses a page whose OBJECTIDs don't advance, rather than looping on it", async () => {
		const client = stubClient([{ body: SERVICE }, { body: { count: 3 } }, page(CAGUAS), page(PALM_BAY)])

		await expect(downloadUSGSStructures(client, { outputDir: scratch.path, layers: [POST_OFFICES] })).rejects.toThrow(
			/don't advance/
		)
	})

	it("raises on the ArcGIS error body the service sends under status 200", async () => {
		const client = stubClient([{ body: SERVICE }, { body: { error: { code: 400, message: "Invalid query" } } }])

		await expect(downloadUSGSStructures(client, { outputDir: scratch.path, layers: [POST_OFFICES] })).rejects.toThrow(
			/ArcGIS service answered an error 400 — Invalid query/
		)
	})
})
