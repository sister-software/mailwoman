// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the post-office layer from two sources written in this test: a mapping
 *   agency's list and a postal operator's list under different licenses.
 *
 *   The first holds the USGS National Map's Palm Bay and Caguas post offices as
 *   served on 2026-11-09, plus one record with no point.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { readLayerManifest } from "@mailwoman/core/layers"
import {
	PostOfficeProvenance,
	type PostOfficeRecord,
	type PostOfficeSource,
} from "@mailwoman/corpus/post-offices/source"
import { getPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import { POILookup, type POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildPostOfficeLayer, postOfficeCategoryID } from "#tools/pipeline/post-offices/build"
import type { PostOfficeSourceDatabase } from "#tools/pipeline/post-offices/schema"

async function* fromArray(records: PostOfficeRecord[]): AsyncIterable<PostOfficeRecord> {
	yield* records
}

function testSource(
	overrides: Pick<PostOfficeSource, "id" | "country" | "license" | "provenance">,
	records: PostOfficeRecord[]
): PostOfficeSource {
	return {
		publisher: `${overrides.id} publisher`,
		attribution: `${overrides.id} attribution`,
		registerSource: `${overrides.id}-register`,
		fetchCommand: `fetch ${overrides.id}`,
		...overrides,
		read: async () => ({ vintage: "2026-11-09", records: fromArray(records) }),
	}
}

const MAPPING_AGENCY = testSource(
	{
		id: "mapping-agency-list",
		country: "US",
		license: "LicenseRef-USGov-Public-Domain",
		provenance: PostOfficeProvenance.MappingAgency,
	},
	[
		{
			id: "0087eaa9-8730-40a8-9733-23eaffb0afbb",
			name: "Palm Bay West Post Office",
			point: { latitude: 27.998160830234198, longitude: -80.69800307551182 },
			address: null,
		},
		{
			id: "09da8555-c417-407d-8f43-732d68559157",
			name: "North Post Office",
			point: { latitude: 18.236371487178346, longitude: -66.03415442360408 },
			address: null,
		},
		{ id: "no-point", name: "Pointless Post Office", point: null, address: null },
	]
)

const POSTAL_OPERATOR = testSource(
	{ id: "postal-operator-list", country: "FR", license: "CC-BY-4.0", provenance: PostOfficeProvenance.PostalOperator },
	[{ id: "75001", name: "Paris Louvre", point: { latitude: 48.8625, longitude: 2.3412 }, address: null }]
)

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("post-office-layer-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

describe("postOfficeCategoryID", () => {
	it("resolves to the taxonomy category whose OSM tag is a post office", () => {
		expect(getPOICategory(postOfficeCategoryID())?.osmTag).toBe("amenity=post_office")
	})
})

describe("buildPostOfficeLayer", () => {
	it("folds every source into one layer whose manifest states each source's license and record count", async () => {
		const out = scratch.path("post-offices.db")

		const result = await buildPostOfficeLayer({
			sources: [MAPPING_AGENCY, POSTAL_OPERATOR],
			sourcesRoot: PathBuilder.from(scratch.path("sources")),
			out,
			buildSHA: "deadbeef",
			createdAt: "2026-11-11T00:00:00Z",
		})

		expect(result.rows).toBe(3)
		expect(Object.fromEntries(result.countries)).toEqual({ US: 2, FR: 1 })

		using kdb = new DatabaseClient<POIDatabase & PostOfficeSourceDatabase>(out, { readOnly: true })

		expect(await readLayerManifest(kdb)).toMatchObject({
			name: "post-offices",
			tier: "shipped",
			license: "LicenseRef-USGov-Public-Domain AND CC-BY-4.0",
			source: "mapping-agency-list+postal-operator-list",
			sourceVintage: "mapping-agency-list=2026-11-09 postal-operator-list=2026-11-09",
			sourceRecords: { "mapping-agency-list": 3, "postal-operator-list": 1 },
		})

		const sources = await kdb.selectFrom("post_office_source").selectAll().orderBy("source_id").execute()

		expect(
			sources.map(({ source_id, country, provenance, input_records, records_without_point }) => ({
				source_id,
				country,
				provenance,
				input_records,
				records_without_point,
			}))
		).toEqual([
			{
				source_id: "mapping-agency-list",
				country: "US",
				provenance: "mapping-agency",
				input_records: 3,
				records_without_point: 1,
			},
			{
				source_id: "postal-operator-list",
				country: "FR",
				provenance: "postal-operator",
				input_records: 1,
				records_without_point: 0,
			},
		])
	})

	it("answers a post office's name, and a post-office category search near a point, with the row's source key", async () => {
		const out = scratch.path("post-offices.db")

		await buildPostOfficeLayer({
			sources: [MAPPING_AGENCY],
			sourcesRoot: PathBuilder.from(scratch.path("sources")),
			out,
			buildSHA: "deadbeef",
		})

		using lookup = new POILookup({ databasePath: out })

		const [byName] = lookup.search({ name: "Palm Bay West Post Office" })

		expect(byName).toMatchObject({
			name: "Palm Bay West Post Office",
			categoryID: postOfficeCategoryID(),
			country: "US",
			gersID: "mapping-agency-list:0087eaa9-8730-40a8-9733-23eaffb0afbb",
		})

		const [nearCaguas] = lookup.search({
			categoryIDs: [postOfficeCategoryID()],
			center: { latitude: 18.2341, longitude: -66.0485 },
			limit: 1,
		})

		expect(nearCaguas?.name).toBe("North Post Office")
	})

	it("marks the layer build-local when a contributing license carries share-alike", async () => {
		const out = scratch.path("post-offices.db")

		const shareAlike = testSource(
			{ id: "share-alike-list", country: "DE", license: "ODbL-1.0", provenance: PostOfficeProvenance.MappingAgency },
			[{ id: "1", name: "Postfiliale", point: { latitude: 52.52, longitude: 13.405 }, address: null }]
		)

		await buildPostOfficeLayer({
			sources: [MAPPING_AGENCY, shareAlike],
			sourcesRoot: PathBuilder.from(scratch.path("sources")),
			out,
			buildSHA: "deadbeef",
		})

		using kdb = new DatabaseClient<POIDatabase>(out, { readOnly: true })

		expect((await readLayerManifest(kdb)).tier).toBe("build-local")
	})

	it("refuses to build with no source", async () => {
		await expect(
			buildPostOfficeLayer({
				sources: [],
				sourcesRoot: PathBuilder.from(scratch.path("sources")),
				out: scratch.path("post-offices.db"),
				buildSHA: "deadbeef",
			})
		).rejects.toThrow(/no post-office source is registered/)
	})
})
