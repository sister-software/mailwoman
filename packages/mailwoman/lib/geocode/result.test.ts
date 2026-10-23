/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The register row behind a coordinate reaches the geocode result under its own stamp. The street
 *   tier writes the row's `source` onto the street node, and the extractor carries it into
 *   `coordinate_source` unchanged, so an OpenStreetMap row keeps `openstreetmap:<cc>` and no other row
 *   gains it.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { isOpenStreetMapSource } from "@mailwoman/core/geocode"
import type { AddressPointHit, AddressPointLookup } from "@mailwoman/core/resolver"
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

function geocodeThrough(hit: AddressPointHit | null): ReturnType<typeof extractGeocodeResult> {
	const tree = addressTree()

	if (hit) {
		applyAddressPoint(tree.roots, lookupAnswering(hit))
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

describe("coordinate_source", () => {
	it("keeps an OpenStreetMap row's stamp and release", () => {
		const result = geocodeThrough({ ...ROW, source: "openstreetmap:nz", release: "2026-08-06" })

		expect(result.resolution_tier).toBe("address_point")
		expect(result.coordinate_source).toEqual({ source: "openstreetmap:nz", release: "2026-08-06" })
	})

	it("keeps a street-recovered OpenStreetMap row's stamp verbatim", () => {
		const result = geocodeThrough({ ...ROW, source: "openstreetmap:nz#recovered", release: "2026-08-06" })

		expect(result.coordinate_source?.source).toBe("openstreetmap:nz#recovered")
		expect(isOpenStreetMapSource(result.coordinate_source?.source)).toBe(true)
	})

	it("reports a non-OSM row under its own stamp and never as OpenStreetMap", () => {
		const result = geocodeThrough({ ...ROW, source: "overture:NAD", release: "2026-05-20.0" })

		expect(result.coordinate_source).toEqual({ source: "overture:NAD", release: "2026-05-20.0" })
		expect(isOpenStreetMapSource(result.coordinate_source?.source)).toBe(false)
	})

	it("is null when the gazetteer's admin ladder placed the coordinate", () => {
		const result = geocodeThrough(null)

		expect(result.resolution_tier).toBe("admin")
		expect(result.lat).toBe(-37.1368)
		expect(result.coordinate_source).toBeNull()
	})
})
