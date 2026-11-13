// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the structures layer from two sources written in this test: a mapping agency's
 *   compilation and a postal operator's list of its post offices, under different licenses.
 *
 *   The first holds the USGS National Map's Palm Bay and Caguas post offices as served on
 *   2026-11-09, Bethany College as served on 2026-11-13, and one record with no point.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { readLayerManifest } from "@mailwoman/core/layers"
import {
	postOfficeCategoryID,
	StructureProvenance,
	type StructureRecord,
	type StructureSource,
} from "@mailwoman/corpus/structures/source"
import { POILookup, type POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildStructureLayer } from "#tools/pipeline/structures/build"
import type { StructureSourceDatabase } from "#tools/pipeline/structures/schema"

async function* fromArray(records: StructureRecord[]): AsyncIterable<StructureRecord> {
	yield* records
}

function testSource(
	overrides: Pick<StructureSource, "id" | "country" | "license" | "provenance">,
	records: StructureRecord[]
): StructureSource {
	return {
		publisher: `${overrides.id} publisher`,
		attribution: `${overrides.id} attribution`,
		registerSource: `${overrides.id}-register`,
		fetchCommand: `fetch ${overrides.id}`,
		...overrides,
		read: async () => ({ vintage: "2026-11-09", records: fromArray(records) }),
	}
}

const POST_OFFICE = postOfficeCategoryID()

const MAPPING_AGENCY_RECORDS: StructureRecord[] = [
	{
		id: "0087eaa9-8730-40a8-9733-23eaffb0afbb",
		name: "Palm Bay West Post Office",
		category: POST_OFFICE,
		point: { latitude: 27.998160830234198, longitude: -80.69800307551182 },
		address: null,
	},
	{
		id: "09da8555-c417-407d-8f43-732d68559157",
		name: "North Post Office",
		category: POST_OFFICE,
		point: { latitude: 18.236371487178346, longitude: -66.03415442360408 },
		address: null,
	},
	{
		id: "06d7db6c-b514-436e-a87b-1978e13aa6e3",
		name: "Bethany College",
		category: "college_university",
		point: { latitude: 38.579165486897814, longitude: -97.67374919089188 },
		address: null,
	},
	{ id: "no-point", name: "Pointless Post Office", category: POST_OFFICE, point: null, address: null },
]

const MAPPING_AGENCY = testSource(
	{
		id: "mapping-agency-list",
		country: "US",
		license: "LicenseRef-USGov-Public-Domain",
		provenance: StructureProvenance.MappingAgency,
	},
	MAPPING_AGENCY_RECORDS
)

const POSTAL_OPERATOR = testSource(
	{ id: "postal-operator-list", country: "FR", license: "CC-BY-4.0", provenance: StructureProvenance.PostalOperator },
	[
		{
			id: "75001",
			name: "Paris Louvre",
			category: POST_OFFICE,
			point: { latitude: 48.8625, longitude: 2.3412 },
			address: null,
		},
	]
)

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("structure-layer-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

describe("buildStructureLayer", () => {
	it("folds every source into one layer whose manifest states each source's license and record count", async () => {
		const out = scratch.path("structures.db")

		const result = await buildStructureLayer({
			sources: [MAPPING_AGENCY, POSTAL_OPERATOR],
			sourcesRoot: PathBuilder.from(scratch.path("sources")),
			out,
			buildSHA: "deadbeef",
			createdAt: "2026-11-11T00:00:00Z",
		})

		const withPoint = [...MAPPING_AGENCY_RECORDS.filter((record) => record.point), "Paris Louvre"]

		expect(result.rows).toBe(withPoint.length)
		expect(result.sources.get("mapping-agency-list")?.categories).toEqual({ [POST_OFFICE]: 2, college_university: 1 })

		using kdb = new DatabaseClient<POIDatabase & StructureSourceDatabase>(out, { readOnly: true })

		expect(await readLayerManifest(kdb)).toMatchObject({
			name: "structures",
			tier: "shipped",
			license: "LicenseRef-USGov-Public-Domain AND CC-BY-4.0",
			source: "mapping-agency-list+postal-operator-list",
			sourceVintage: "mapping-agency-list=2026-11-09 postal-operator-list=2026-11-09",
			sourceRecords: { "mapping-agency-list": MAPPING_AGENCY_RECORDS.length, "postal-operator-list": 1 },
		})

		const sources = await kdb.selectFrom("structure_source").selectAll().orderBy("source_id").execute()

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
				input_records: MAPPING_AGENCY_RECORDS.length,
				records_without_point: MAPPING_AGENCY_RECORDS.filter((record) => !record.point).length,
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

	it("answers a structure's name, and a category search near a point, with the row's source key", async () => {
		const out = scratch.path("structures.db")

		await buildStructureLayer({
			sources: [MAPPING_AGENCY],
			sourcesRoot: PathBuilder.from(scratch.path("sources")),
			out,
			buildSHA: "deadbeef",
		})

		using lookup = new POILookup({ databasePath: out })

		const [byName] = lookup.search({ name: "Palm Bay West Post Office" })

		expect(byName).toMatchObject({
			name: "Palm Bay West Post Office",
			categoryID: POST_OFFICE,
			country: "US",
			gersID: "mapping-agency-list:0087eaa9-8730-40a8-9733-23eaffb0afbb",
		})

		const [nearCaguas] = lookup.search({
			categoryIDs: [POST_OFFICE],
			center: { latitude: 18.2341, longitude: -66.0485 },
			limit: 1,
		})

		expect(nearCaguas?.name).toBe("North Post Office")

		const [nearLindsborg] = lookup.search({
			categoryIDs: ["college_university"],
			center: { latitude: 38.5736, longitude: -97.6745 },
			limit: 1,
		})

		expect(nearLindsborg?.name).toBe("Bethany College")
	})

	it("refuses a record whose category the POI taxonomy doesn't hold", async () => {
		const unknown = testSource(
			{ id: "unknown-category", country: "US", license: "CC0-1.0", provenance: StructureProvenance.MappingAgency },
			[
				{
					id: "1",
					name: "Somewhere",
					category: "no_such_category",
					point: { latitude: 1, longitude: 1 },
					address: null,
				},
			]
		)

		await expect(
			buildStructureLayer({
				sources: [unknown],
				sourcesRoot: PathBuilder.from(scratch.path("sources")),
				out: scratch.path("structures.db"),
				buildSHA: "deadbeef",
			})
		).rejects.toThrow(/"no_such_category", which the POI taxonomy doesn't hold/)
	})

	it("marks the layer build-local when a contributing license carries share-alike", async () => {
		const out = scratch.path("structures.db")

		const shareAlike = testSource(
			{ id: "share-alike-list", country: "DE", license: "ODbL-1.0", provenance: StructureProvenance.MappingAgency },
			[
				{
					id: "1",
					name: "Postfiliale",
					category: POST_OFFICE,
					point: { latitude: 52.52, longitude: 13.405 },
					address: null,
				},
			]
		)

		await buildStructureLayer({
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
			buildStructureLayer({
				sources: [],
				sourcesRoot: PathBuilder.from(scratch.path("sources")),
				out: scratch.path("structures.db"),
				buildSHA: "deadbeef",
			})
		).rejects.toThrow(/no structure source is registered/)
	})
})
