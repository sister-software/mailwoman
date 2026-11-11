/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the seven-feature fixture from the 2026-11-09 pull of the USGS structures layer through the
 *   post-office source, laid out as `mailwoman corpus fetch usgs-post-offices` writes it.
 */

import { copyFileTo, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { PostOfficeProvenance } from "#post-offices/source"
import { POST_OFFICE_SOURCES } from "#post-offices/sources"
import { useScratchDir } from "#test-kit"
import {
	USGOV_USGS_POST_OFFICES_ADAPTER_ID,
	USGS_POST_OFFICES_FILENAME,
} from "#us/adapters/usgov/usgs-post-offices/adapter"
import { usgsNationalMapPostOffices } from "#us/post-offices/usgs-national-map"

const scratch = useScratchDir("usgs-national-map-post-offices")

const fixture = workspacePath("corpus", "fixtures", "usgov-usgs-post-offices", "sample.geojsonl")

async function layOutFetch(): Promise<PathBuilder> {
	const root = PathBuilder.from(scratch.path("sources"))

	await copyFileTo(fixture, root(USGOV_USGS_POST_OFFICES_ADAPTER_ID, USGS_POST_OFFICES_FILENAME))

	await writeLocalJSONFile(
		{ downloaded_at: "2026-11-09T18:00:00.000Z", feature_count: 7 },
		root(USGOV_USGS_POST_OFFICES_ADAPTER_ID, "MANIFEST.json")
	)

	return root
}

describe("usgsNationalMapPostOffices", () => {
	it("is registered as a mapping agency's list under the US federal public-domain license", () => {
		expect(POST_OFFICE_SOURCES).toContain(usgsNationalMapPostOffices)

		expect(usgsNationalMapPostOffices).toMatchObject({
			country: "US",
			provenance: PostOfficeProvenance.MappingAgency,
			license: "LicenseRef-USGov-Public-Domain",
			registerSource: "us-public-administration-3",
		})
	})

	it("reads every feature with its point and split address, and the fetch date as the vintage", async () => {
		const read = await usgsNationalMapPostOffices.read(await layOutFetch())
		const records = await Array.fromAsync(read.records)

		expect(read.vintage).toBe("2026-11-09")
		expect(records).toHaveLength(7)

		expect(records.find((record) => record.id === "09da8555-c417-407d-8f43-732d68559157")).toEqual({
			id: "09da8555-c417-407d-8f43-732d68559157",
			name: "North Post Office",
			point: { latitude: 18.236371487178346, longitude: -66.03415442360408 },
			address: {
				house_number: "555",
				street: "Calle Munoz Rivera",
				locality: "Caguas",
				region: "PR",
				postcode: "00725",
			},
		})

		// Pocono Manor publishes no street address, so it has a point and no address.
		const pocono = records.find((record) => record.id === "c5989229-529a-4596-afd3-c088e64de291")!

		expect(pocono.point).not.toBeNull()
		expect(pocono.address).toBeNull()
	})

	it("refuses to read a source directory with no record of its fetch", async () => {
		await expect(usgsNationalMapPostOffices.read(PathBuilder.from(scratch.path("empty")))).rejects.toThrow(
			/holds no MANIFEST\.json/
		)
	})
})
