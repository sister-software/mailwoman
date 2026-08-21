/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Coverage for the OpenAddresses resolver eval's pure halves — the tree walkers that decide WHICH place a row
 *   resolved to, and the region predicate that decides whether it counts.
 */

import type { AddressNode, AddressTree, ComponentTag } from "@mailwoman/core/decoder"
import { regionMatches } from "mailwoman/eval-harness/oa-resolver/admin-match"
import {
	collectResolved,
	findAddressPointHit,
	findInterpolatedHit,
	findInterpolationSpans,
	hasStreetHouseNumber,
	mostSpecific,
	type Resolved,
} from "mailwoman/eval-harness/oa-resolver/tree-hits"
import { describe, expect, it } from "vitest"

function node(tag: string, value: string, extra: Partial<AddressNode> = {}): AddressNode {
	return {
		tag: tag as ComponentTag,
		value,
		start: 0,
		end: value.length,
		confidence: 1,
		children: [],
		...extra,
	}
}

function tree(...roots: AddressNode[]): AddressTree {
	return { raw: roots.map((r) => r.value).join(" "), roots }
}

describe("findAddressPointHit", () => {
	it("returns the address point stamped on a street node, however deep", () => {
		const street = node("street", "Main St", { metadata: { address_point: { lat: 40.1, lon: -74.2 } } })
		const locality = node("locality", "Trenton", { children: [street] })

		expect(findAddressPointHit(tree(locality))).toEqual({ lat: 40.1, lon: -74.2 })
	})

	it("ignores the stamp on any tag other than street", () => {
		const locality = node("locality", "Trenton", { metadata: { address_point: { lat: 40.1, lon: -74.2 } } })

		expect(findAddressPointHit(tree(locality))).toBeNull()
	})

	it("returns null when no node carries the stamp", () => {
		expect(findAddressPointHit(tree(node("street", "Main St")))).toBeNull()
	})

	it("does not confuse the interpolated stamp for the exact one", () => {
		const street = node("street", "Main St", { metadata: { interpolated_point: { lat: 1, lon: 2 } } })

		expect(findAddressPointHit(tree(street))).toBeNull()
		expect(findInterpolatedHit(tree(street))).toEqual({ lat: 1, lon: 2 })
	})
})

describe("collectResolved", () => {
	it("collects every resolver-attributed node, reading the id off the wof: URI", () => {
		const region = node("region", "California", {
			placeID: "wof:85688637",
			sourceID: "region:85688637",
			lat: 37,
			lon: -120,
			metadata: { resolver_name: "California" },
		})

		const locality = node("locality", "Oakland", {
			placeID: "wof:85921881",
			sourceID: "locality:85921881",
			lat: 37.8,
			lon: -122.2,
			metadata: { resolver_name: "Oakland" },
			children: [region],
		})

		expect(collectResolved(tree(locality))).toEqual<Resolved[]>([
			{ id: 85_921_881, name: "Oakland", placetype: "locality", lat: 37.8, lon: -122.2 },
			{ id: 85_688_637, name: "California", placetype: "region", lat: 37, lon: -120 },
		])
	})

	it("skips nodes the resolver never attributed, and attributed nodes with no coordinate", () => {
		const unattributed = node("locality", "Oakland")
		const coordless = node("region", "California", { placeID: "wof:85688637", sourceID: "region:85688637" })
		const foreign = node("country", "US", { placeID: "geonames:6252001", lat: 1, lon: 2 })

		expect(collectResolved(tree(unattributed, coordless, foreign))).toEqual([])
	})

	it("surfaces a dual-role node's extra interpretations as their own resolved places", () => {
		const berlin = node("region", "Berlin", {
			placeID: "wof:85682571",
			sourceID: "region:85682571",
			lat: 52.5,
			lon: 13.4,
			metadata: { resolver_name: "Berlin" },
			interpretations: [
				{
					tag: "locality" as ComponentTag,
					placeID: "wof:101748283",
					sourceID: "locality:101748283",
					lat: 52.51,
					lon: 13.41,
					metadata: { resolver_name: "Berlin" },
				},
			],
		})

		expect(collectResolved(tree(berlin))).toEqual<Resolved[]>([
			{ id: 85_682_571, name: "Berlin", placetype: "region", lat: 52.5, lon: 13.4 },
			{ id: 101_748_283, name: "Berlin", placetype: "locality", lat: 52.51, lon: 13.41 },
		])
	})

	it("falls back to the node's own text when the resolver stamped no name", () => {
		const loc = node("locality", "Oakland", { placeID: "wof:85921881", sourceID: "locality:85921881", lat: 1, lon: 2 })

		expect(collectResolved(tree(loc))[0]?.name).toBe("Oakland")
	})
})

describe("mostSpecific", () => {
	const region: Resolved = { id: 1, name: "California", placetype: "region", lat: 37, lon: -120 }
	const county: Resolved = { id: 2, name: "Alameda", placetype: "county", lat: 37.6, lon: -122 }
	const locality: Resolved = { id: 3, name: "Oakland", placetype: "locality", lat: 37.8, lon: -122.2 }

	it("picks the finest placetype regardless of input order", () => {
		expect(mostSpecific([region, locality, county])).toBe(locality)
		expect(mostSpecific([locality, county, region])).toBe(locality)
	})

	it("returns null for an empty set", () => {
		expect(mostSpecific([])).toBeNull()
	})

	it("keeps a ranked placetype over an unranked one", () => {
		const unranked: Resolved = { id: 4, name: "???", placetype: "not_a_placetype", lat: 0, lon: 0 }

		expect(mostSpecific([unranked, region])).toBe(region)
		expect(mostSpecific([region, unranked])).toBe(region)
	})

	it("returns an unranked place only when nothing else resolved", () => {
		const unranked: Resolved = { id: 4, name: "???", placetype: "not_a_placetype", lat: 0, lon: 0 }

		expect(mostSpecific([unranked])).toBe(unranked)
	})
})

describe("regionMatches", () => {
	it("matches two identical surface forms", () => {
		expect(regionMatches("Berlin", "berlin")).toBe(true)
	})

	it("folds a US canonical state name onto OA's USPS abbreviation", () => {
		expect(regionMatches("California", "CA")).toBe(true)
		expect(regionMatches("District of Columbia", "DC")).toBe(true)
	})

	it("folds WOF's German exonym onto the native name", () => {
		expect(regionMatches("Saxony", "Sachsen")).toBe(true)
	})

	it("folds a French région across its accents", () => {
		expect(regionMatches("Île-de-France", "Ile-de-France")).toBe(true)
	})

	it("still misses two genuinely different regions", () => {
		expect(regionMatches("Bavaria", "Sachsen")).toBe(false)
		expect(regionMatches("California", "NV")).toBe(false)
	})

	it("misses when either side is absent", () => {
		expect(regionMatches(undefined, "CA")).toBe(false)
		expect(regionMatches("California", undefined)).toBe(false)
	})
})

describe("street-level preconditions", () => {
	it("requires BOTH a street and a house number", () => {
		const street = node("street", "Main St", { children: [node("house_number", "12")] })

		expect(hasStreetHouseNumber(tree(street))).toBe(true)
		expect(hasStreetHouseNumber(tree(node("street", "Main St")))).toBe(false)
		expect(hasStreetHouseNumber(null)).toBe(false)
	})

	it("reads the first non-empty street / house-number / postcode values", () => {
		const street = node("street", "Main St", {
			children: [node("house_number", "12"), node("postcode", "08608")],
		})

		expect(findInterpolationSpans(tree(street))).toEqual({
			street: "Main St",
			houseNumber: "12",
			postcode: "08608",
		})
	})

	it("treats a whitespace-only span as absent", () => {
		const street = node("street", "   ", { children: [node("house_number", "12")] })

		expect(findInterpolationSpans(tree(street))).toEqual({
			street: undefined,
			houseNumber: "12",
			postcode: undefined,
		})
	})
})
