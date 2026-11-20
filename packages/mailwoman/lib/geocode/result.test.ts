// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The register row behind a coordinate reaches the geocode result under its own stamp. The street
 *   tier writes the row's `source` onto the street node, and the extractor copies that value into
 *   `coordinate_source` unchanged, so an OpenStreetMap row keeps `openstreetmap:<cc>` and no other row
 *   gains it.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { isOpenStreetMapSource } from "@mailwoman/core/geocode"
import {
	type AddressPointHit,
	type AddressPointLookup,
	EMPTY_PLACE_FIELDS,
	type ResolvedPlace,
} from "@mailwoman/core/resolver"
import { decorateNode } from "@mailwoman/resolver/decorate-node"
import { applyAddressPoint } from "@mailwoman/resolver/street/tier"
import { describe, expect, it } from "vitest"

import { extractGeocodeResult } from "#geocode/result"

const INPUT = "620B Pollen Street, Thames"

function addressTree(): AddressTree {
	const houseNumber: AddressNode = { tag: "house_number", value: "620B", start: 0, end: 4, confidence: 1, children: [] }

	return {
		raw: INPUT,
		roots: [
			{ tag: "street", value: "Pollen Street", start: 5, end: 18, confidence: 1, children: [houseNumber] },
			{
				tag: "locality",
				value: "Thames",
				start: 20,
				end: 26,
				confidence: 1,
				children: [],
				lat: -37.1368,
				lon: 175.6056,
			},
		],
	}
}

function lookupAnswering(hit: AddressPointHit): AddressPointLookup {
	return { find: () => hit }
}

async function geocodeThrough(hit: AddressPointHit | null): Promise<ReturnType<typeof extractGeocodeResult>> {
	const tree = addressTree()

	if (hit) {
		await applyAddressPoint(tree.roots, lookupAnswering(hit))
	}

	return extractGeocodeResult(INPUT, tree)
}

const ROW = { lat: -37.137364, lon: 175.541779, localityNorm: null, postcode: null }

describe("the admin ladder and a contained dependent locality (#2804)", () => {
	const DISTRICT = "Didsbury, Manchester"

	function districtTree(stamp: Record<string, unknown> | undefined): AddressTree {
		return {
			raw: DISTRICT,
			roots: [
				{
					tag: "locality",
					value: "Manchester",
					start: 10,
					end: 20,
					confidence: 1,
					children: [
						{
							tag: "dependent_locality",
							value: "Didsbury",
							start: 0,
							end: 8,
							confidence: 1,
							children: [],
							lat: 53.4166,
							lon: -2.2311,
							...(stamp ? { metadata: stamp } : {}),
						},
					],
					lat: 53.4794,
					lon: -2.2453,
				},
			],
		}
	}

	it("answers the dependent locality's point when the resolver stamped it as contained", () => {
		const result = extractGeocodeResult(DISTRICT, districtTree({ contained_by_parent: true }))

		expect(result.lat).toBeCloseTo(53.4166, 4)
		expect(result.lon).toBeCloseTo(-2.2311, 4)
		expect(result.resolution_tier).toBe("admin")
	})

	it("answers the locality's point without the stamp, as the ladder orders today", () => {
		const result = extractGeocodeResult(DISTRICT, districtTree(undefined))

		expect(result.lat).toBeCloseTo(53.4794, 4)
		expect(result.lon).toBeCloseTo(-2.2453, 4)
	})
})

describe("two localities in one tree (#3057)", () => {
	const OXNARD = "Federal Building Oxnard Post Office, Oxnard, CA"

	function twoLocalities(): AddressTree {
		// The parse tags the venue's first word as a locality beside the town written as its own segment.
		return {
			raw: OXNARD,
			roots: [
				{ tag: "locality", value: "Federal", start: 0, end: 7, confidence: 0.6, children: [], lat: 36.4, lon: -119.8 },
				{ tag: "venue", value: "Building Oxnard Post Office", start: 8, end: 35, confidence: 0.8, children: [] },
				{
					tag: "locality",
					value: "Oxnard",
					start: 37,
					end: 43,
					confidence: 0.9,
					children: [],
					lat: 34.1975,
					lon: -119.1771,
				},
				{ tag: "region", value: "CA", start: 45, end: 47, confidence: 0.9, children: [], lat: 37.2, lon: -119.4 },
			],
		}
	}

	it("answers the locality written as a whole comma segment", () => {
		const result = extractGeocodeResult(OXNARD, twoLocalities())

		expect(result.lat).toBeCloseTo(34.1975, 4)
		expect(result.lon).toBeCloseTo(-119.1771, 4)
		expect(result.locality).toBe("Oxnard")
	})

	it("keeps the first locality when no venue shares its segment", () => {
		// The parse tags the state as a locality.
		// That locality resolves to a namesake in another state.
		const input = "Avenida Country Club, Barcelona 6001, Anzoátegui, Venezuela"

		const tree: AddressTree = {
			raw: input,
			roots: [
				{
					tag: "locality",
					value: "Barcelona",
					start: 22,
					end: 31,
					confidence: 0.9,
					children: [],
					lat: 10.133,
					lon: -64.692,
				},
				{
					tag: "locality",
					value: "Anzoátegui",
					start: 38,
					end: 48,
					confidence: 0.6,
					children: [],
					lat: 9.603,
					lon: -69.898,
				},
			],
		}

		const result = extractGeocodeResult(input, tree)

		expect(result.lat).toBeCloseTo(10.133, 3)
		expect(result.locality).toBe("Barcelona")
	})
})

describe("candidate scores", () => {
	const SPRINGFIELD = "Springfield"

	function springfieldTree(winnerMetadata: Record<string, unknown>): AddressTree {
		return {
			raw: SPRINGFIELD,
			roots: [
				{
					tag: "locality",
					value: SPRINGFIELD,
					start: 0,
					end: 11,
					confidence: 1,
					children: [],
					lat: 39.7817,
					lon: -89.6501,
					placeID: "wof:85940429",
					metadata: { resolver_name: "Springfield", resolver_country: "us", ...winnerMetadata },
					alternatives: [
						{
							name: "Springfield",
							placetype: "locality",
							lat: 42.1015,
							lon: -72.5898,
							country: "US",
							id: 85_950_361,
							score: 5.1,
						},
						{ name: "Springfield", placetype: "locality", lat: 37.2153, lon: -93.2982, country: "US", id: 85_948_219 },
					],
				} as AddressNode,
			],
		}
	}

	it("reads the winner's resolver score and each runner-up's own score", () => {
		const { candidates } = extractGeocodeResult(SPRINGFIELD, springfieldTree({ resolver_score: 6.3 }))

		expect(candidates.map((candidate) => [candidate.placeID, candidate.score])).toEqual([
			["wof:85940429", 6.3],
			["wof:85950361", 5.1],
			["wof:85948219", null],
		])
	})

	it("answers null for a winner whose resolver recorded no score", () => {
		const { candidates } = extractGeocodeResult(SPRINGFIELD, springfieldTree({}))

		expect(candidates[0]?.score).toBeNull()
	})

	it("reports a score ranked from an unrecorded population as null with the reason", () => {
		const { candidates } = extractGeocodeResult(
			SPRINGFIELD,
			springfieldTree({ resolver_score: 0, resolver_score_unmeasured: "population_unrecorded" })
		)

		expect(candidates[0]).toMatchObject({ score: null, scoreUnmeasured: "population_unrecorded" })
		expect(candidates[1]).toMatchObject({ score: 5.1 })
		expect(candidates[1]).not.toHaveProperty("scoreUnmeasured")
	})

	it("states an alias win on the winner and leaves a primary-name win without the field", () => {
		const alias = extractGeocodeResult(SPRINGFIELD, springfieldTree({ resolver_matched_alias: true }))
		const primary = extractGeocodeResult(SPRINGFIELD, springfieldTree({}))

		expect(alias.candidates[0]?.matchedAlias).toBe(true)
		expect(primary.candidates[0]).not.toHaveProperty("matchedAlias")
	})
})

describe("candidates across spans and re-picks", () => {
	const CAMDEN_NJ = "Camden, New Jersey"

	const camden = (id: number, placetype: string, lat: number, lon: number): ResolvedPlace => ({
		...EMPTY_PLACE_FIELDS,
		id,
		name: "Camden",
		placetype,
		country: "US",
		lat,
		lon,
		score: 4.85,
	})

	function tree(): AddressTree {
		const locality: AddressNode = { tag: "locality", value: "Camden", start: 0, end: 6, confidence: 1, children: [] }
		const region: AddressNode = { tag: "region", value: "New Jersey", start: 8, end: 18, confidence: 1, children: [] }

		// The walk's pick, with a localadmin runner-up at the same coordinate.
		decorateNode(locality, camden(85_921_237, "locality", 33.567931, -92.839659), [
			camden(404_477_989, "localadmin", 39.936906, -75.11261),
		])

		// A later pass replaces the pick.
		decorateNode(locality, camden(85_975_673, "locality", 39.936906, -75.11261), [])

		decorateNode(
			region,
			{ ...camden(85_688_747, "region", 40.1, -74.6), name: "New Jersey" },
			[],
			[{ ...camden(1_108_804_011, "county", 40.5, -74.3), name: "New Jersey County" }]
		)

		return { raw: CAMDEN_NJ, roots: [locality, region] }
	}

	it("lists the replaced pick, a same-coordinate runner-up, and another span's probe loser under their own spans", () => {
		const { candidates } = extractGeocodeResult(CAMDEN_NJ, tree())

		expect(candidates.map((c) => [c.tag, c.value, c.placetype, c.placeID])).toEqual([
			["locality", "Camden", "locality", "wof:85975673"],
			["locality", "Camden", "locality", "wof:85921237"],
			["locality", "Camden", "localadmin", "wof:404477989"],
			["region", "New Jersey", "county", "wof:1108804011"],
		])
	})
})

describe("coordinate_source", () => {
	it("keeps an OpenStreetMap row's stamp and release", async () => {
		const result = await geocodeThrough({ ...ROW, source: "openstreetmap:nz", release: "2026-08-06" })

		expect(result.resolution_tier).toBe("address_point")
		expect(result.coordinate_source).toEqual({ source: "openstreetmap:nz", release: "2026-08-06" })
	})

	it("keeps a street-recovered OpenStreetMap row's stamp verbatim", async () => {
		const result = await geocodeThrough({ ...ROW, source: "openstreetmap:nz#recovered", release: "2026-08-06" })

		expect(result.coordinate_source?.source).toBe("openstreetmap:nz#recovered")
		expect(isOpenStreetMapSource(result.coordinate_source?.source)).toBe(true)
	})

	it("reports a non-OSM row under its own stamp and never as OpenStreetMap", async () => {
		const result = await geocodeThrough({ ...ROW, source: "overture:NAD", release: "2026-05-20.0" })

		expect(result.coordinate_source).toEqual({ source: "overture:NAD", release: "2026-05-20.0" })
		expect(isOpenStreetMapSource(result.coordinate_source?.source)).toBe(false)
	})

	it("is null when the gazetteer's admin ladder placed the coordinate", async () => {
		const result = await geocodeThrough(null)

		expect(result.resolution_tier).toBe("admin")
		expect(result.lat).toBe(-37.1368)
		expect(result.coordinate_source).toBeNull()
	})
})
