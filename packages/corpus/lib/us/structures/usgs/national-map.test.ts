// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads the fixture from the 2026-11-13 pull of the USGS structures MapServer through
 *   the structures source, laid out as `mailwoman corpus fetch usgs-structures` writes it.
 */

import { copyFileTo, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { getPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { postOfficeCategoryID, StructureProvenance } from "#structures/source"
import { STRUCTURE_SOURCES } from "#structures/sources"
import { useScratchDir } from "#test-kit"
import {
	USGOV_USGS_STRUCTURES_ADAPTER_ID,
	USGS_STRUCTURES_FILENAME,
	type USGSStructureFeature,
} from "#us/adapters/usgov/usgs-structures/adapter"
import { usgsStructureLayer } from "#us/structures/usgs/layers"
import { usgsNationalMapStructures } from "#us/structures/usgs/national-map"

const scratch = useScratchDir("usgs-national-map-structures")

const fixture = workspacePath("corpus", "fixtures", "usgov-usgs-structures", "sample.geojsonl")

async function layOutFetch(): Promise<PathBuilder> {
	const root = PathBuilder.from(scratch.path("sources"))

	await copyFileTo(fixture, root(USGOV_USGS_STRUCTURES_ADAPTER_ID, USGS_STRUCTURES_FILENAME))

	await writeLocalJSONFile(
		{ downloaded_at: "2026-11-13T21:00:00.000Z" },
		root(USGOV_USGS_STRUCTURES_ADAPTER_ID, "MANIFEST.json")
	)

	return root
}

describe("usgsNationalMapStructures", () => {
	it("is registered as a mapping agency's list under the US federal public-domain license", () => {
		expect(STRUCTURE_SOURCES).toContain(usgsNationalMapStructures)

		expect(usgsNationalMapStructures).toMatchObject({
			country: "US",
			provenance: StructureProvenance.MappingAgency,
			license: "LicenseRef-USGov-Public-Domain",
			registerSource: "us-public-administration-3",
		})
	})

	it("reads every feature with its layer's category, the fetch date as the vintage", async () => {
		const features = await Array.fromAsync(JSONSpliterator.fromAsync<USGSStructureFeature>(fixture))
		const read = await usgsNationalMapStructures.read(await layOutFetch())
		const records = await Array.fromAsync(read.records)

		expect(read.vintage).toBe("2026-11-13")

		expect(records.map((record) => record.id)).toEqual(
			features.map((feature) => feature.properties.permanent_identifier)
		)

		expect(records.map((record) => record.category)).toEqual(
			features.map((feature) => usgsStructureLayer(feature.properties.layer_id).poiCategory)
		)

		expect(records.every((record) => getPOICategory(record.category))).toBe(true)
	})

	it("files a post office under the post-office category, with its point and split address", async () => {
		const read = await usgsNationalMapStructures.read(await layOutFetch())
		const records = await Array.fromAsync(read.records)

		expect(records.find((record) => record.id === "09da8555-c417-407d-8f43-732d68559157")).toEqual({
			id: "09da8555-c417-407d-8f43-732d68559157",
			name: "North Post Office",
			category: postOfficeCategoryID(),
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
		await expect(usgsNationalMapStructures.read(PathBuilder.from(scratch.path("empty")))).rejects.toThrow(
			/holds no MANIFEST\.json/
		)
	})
})
