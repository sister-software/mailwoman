// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Drives the post-office fetcher through the real `APIClient` over a stubbed transport.
 *
 *   The features are ones the USGS structures layer served on 2026-11-09,
 *   in the service's upper-case field spelling.
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
import { USGS_POST_OFFICES_FILENAME, type USGSPostOfficeFeature } from "#us/adapters/usgov/usgs-post-offices/adapter"
import {
	downloadUSGSPostOffices,
	normalizePostOfficeFeature,
	postOfficeZIPCode,
	type USGSPostOfficesManifest,
} from "#us/tools/fetch/usgs-post-offices"

const scratch = useScratchDir("usgs-post-offices-fetch")

const SERVICE = {
	copyrightText: "USGS TNM – National Structures Dataset. Data Refreshed October, 2026.",
	serviceDescription: "The National Map download client allows free downloads of public domain structures data",
}

function serviceFeature(
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
		geometry: { type: "Point", coordinates },
		properties: { PERMANENT_IDENTIFIER: id, NAME: name, ADDRESS: address, CITY: city, STATE: state, ZIPCODE: zipcode },
	}
}

const PALM_BAY = serviceFeature(
	"0087eaa9-8730-40a8-9733-23eaffb0afbb",
	"Palm Bay West Post Office",
	"950 Malabar Road Southwest",
	"Palm Bay",
	"FL",
	"32907",
	[-80.69800307551182, 27.998160830234198]
)

const CAGUAS = serviceFeature(
	"09da8555-c417-407d-8f43-732d68559157",
	"North Post Office",
	"555 Calle Munoz Rivera",
	"Caguas",
	"PR",
	"00725",
	[-66.03415442360408, 18.236371487178346]
)

const LAKEVILLE = serviceFeature(
	"00689248-e551-41f1-b718-d34eb284db3b",
	"Lakeville Post Office",
	"339 Main Street",
	"Lakeville",
	"CT",
	"06039-9992",
	[-73.44045391998858, 41.96564954032993]
)

const page = (...features: unknown[]): StubResult => ({ body: { type: "FeatureCollection", features } })

function stubClient(results: StubResult[]): APIClient & { calls: string[] } {
	const transport = stubTransport(results)

	const client = new APIClient({
		displayName: "usgs post offices test",
		logger: silentLogger(),
		axios: transport.axios,
	})

	return Object.assign(client, { calls: transport.calls })
}

async function readWritten(): Promise<USGSPostOfficeFeature[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<USGSPostOfficeFeature>(scratch.path(USGS_POST_OFFICES_FILENAME)))
}

describe("postOfficeZIPCode", () => {
	it("restores the leading zeros a numeric Puerto Rico ZIP Code lost, and keeps the published value", () => {
		expect(postOfficeZIPCode(725, "PR")).toEqual({ zipcode: "00725", zipcode_published: "725" })
	})

	it("keeps a five-digit ZIP Code and a ZIP+4 as published", () => {
		expect(postOfficeZIPCode("00907", "PR")).toEqual({ zipcode: "00907" })
		expect(postOfficeZIPCode("06039-9992", "CT")).toEqual({ zipcode: "06039-9992" })
	})

	it("reads a value that is no ZIP Code for its state as null, and keeps what was published", () => {
		expect(postOfficeZIPCode("7341", "TX")).toEqual({ zipcode: null, zipcode_published: "7341" })
	})

	it("keeps the trimmed value where the state is not one the codex knows", () => {
		expect(postOfficeZIPCode(" 96940 ", "PW")).toEqual({ zipcode: "96940" })
		expect(postOfficeZIPCode(null, "FL")).toEqual({ zipcode: null })
	})
})

describe("normalizePostOfficeFeature", () => {
	it("lower-cases the service's field names and keeps the point", () => {
		expect(normalizePostOfficeFeature(CAGUAS)).toEqual({
			type: "Feature",
			geometry: { type: "Point", coordinates: [-66.03415442360408, 18.236371487178346] },
			properties: {
				permanent_identifier: "09da8555-c417-407d-8f43-732d68559157",
				name: "North Post Office",
				address: "555 Calle Munoz Rivera",
				city: "Caguas",
				state: "PR",
				zipcode: "00725",
			},
		})
	})

	it("refuses a value that is not a GeoJSON feature", () => {
		expect(() => normalizePostOfficeFeature({ type: "FeatureCollection" })).toThrow(/expected a GeoJSON Feature/)
	})
})

describe("downloadUSGSPostOffices", () => {
	it("counts, pages by resultOffset, and writes every feature with the manifest and service description", async () => {
		const client = stubClient([{ body: SERVICE }, { body: { count: 3 } }, page(PALM_BAY, CAGUAS), page(LAKEVILLE)])

		// A page of two stands in for the service's 2,000, so the second request starts at offset 2.
		const summary = await downloadUSGSPostOffices(client, { outputDir: scratch.path })

		expect(summary).toEqual({ fetched: 1, skipped: 0, failed: 0, failedCodes: [] })
		expect(client.calls).toHaveLength(4)
		expect(client.calls[1]).toContain("returnCountOnly=true")
		expect(client.calls[2]).toContain("resultOffset=0")
		expect(client.calls[3]).toContain("resultOffset=2")
		expect(client.calls.slice(1).every((url) => url.includes("where=FCODE%3D78006"))).toBe(true)

		const written = await readWritten()

		expect(written.map((feature) => feature.properties.zipcode)).toEqual(["32907", "00725", "06039-9992"])

		const manifest = await readLocalJSONFile<USGSPostOfficesManifest>(scratch.path("MANIFEST.json"))

		expect(manifest.feature_count).toBe(3)
		expect(manifest.publisher_version).toBe(SERVICE.copyrightText)
		expect(manifest.filename).toBe(USGS_POST_OFFICES_FILENAME)

		expect(await readLocalJSONFile(scratch.path("service.json"))).toEqual(SERVICE)
	})

	it("refuses a pull that holds fewer features than the service counted, and writes no feature file", async () => {
		const client = stubClient([{ body: SERVICE }, { body: { count: 3 } }, page(PALM_BAY, CAGUAS), page()])

		await expect(downloadUSGSPostOffices(client, { outputDir: scratch.path })).rejects.toThrow(
			/counted 3 post offices and the pull returned 2/
		)

		expect(await pathExists(scratch.path(USGS_POST_OFFICES_FILENAME))).toBe(false)
	})

	it("raises on the ArcGIS error body the service sends under status 200", async () => {
		const client = stubClient([{ body: SERVICE }, { body: { error: { code: 400, message: "Invalid query" } } }])

		await expect(downloadUSGSPostOffices(client, { outputDir: scratch.path })).rejects.toThrow(
			/ArcGIS error 400: Invalid query/
		)
	})
})
