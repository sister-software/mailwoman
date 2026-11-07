/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyCountryAsRegion, applyLocalityAsRegion, applyRegionCity, applyVenueAsTown } from "#resolve/region-city"

const CITY: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 8_962_610_550_807,
	name: "Thành phố Hồ Chí Minh",
	placetype: "locality",
	country: "VN",
	lat: 10.7737261,
	lon: 106.7166008,
	score: 7,
	exactMatch: true,
}

function node(tag: string, value: string, start: number, extra: Partial<AddressNode> = {}): AddressNode {
	return { tag, value, start, end: start + value.length, confidence: 0.9, children: [], ...extra } as AddressNode
}

const backendOf = (places: ResolvedPlace[]): ResolverBackend => ({ findPlace: async () => places })

const streetAddress = () => [
	node("house_number", "34", 0),
	node("street", "Lê Duẩn", 3),
	node("region", "Hồ Chí Minh", 12, { placeID: "wof:8638961045712", lat: 9.78361575, lon: 107.539162 }),
]

describe("applyRegionCity with an unresolved locality", () => {
	it("reads the region as its city when the parsed locality found no row", async () => {
		const roots = [node("locality", "Nowhere", 8), ...streetAddress()]

		await applyRegionCity(roots, backendOf([CITY]))

		expect(roots.find((root) => root.value === "Hồ Chí Minh")).toMatchObject({ tag: "locality", lat: CITY.lat })
	})
})

describe("a country the input names beside a town", () => {
	const place = (name: string, placetype: string, id: number, country: string): ResolvedPlace => ({
		...CITY,
		id,
		name,
		placetype,
		country,
		exactMatch: true,
	})

	const GEORGIA_STATE = place("Georgia", "region", 85_688_535, "US")
	const SAVANNAH = place("Savannah", "locality", 85_936_429, "US")
	const TBILISI = place("Tbilisi", "locality", 421_174_763, "GE")

	const atlas: ResolverBackend = {
		findPlace: async ({ text, placetype, country, parentID }) => {
			if (placetype === "region") return text === "Georgia" ? [GEORGIA_STATE] : []

			if (text === "Tbilisi" && country === "GE") return [TBILISI]

			if (text === "Savannah" && parentID === GEORGIA_STATE.id) return [SAVANNAH]

			return []
		},
	}

	const georgia = () =>
		node("country", "Georgia", 10, { placeID: "wof:85632361", metadata: { resolver_country: "GE" } })

	it("reads the country as the region of that name when only the region holds the town", async () => {
		const roots = [node("locality", "Savannah", 0), georgia()]

		await applyCountryAsRegion(roots, atlas)

		expect(roots[1]).toMatchObject({ tag: "region", placeID: `wof:${GEORGIA_STATE.id}` })
		expect(roots[0]).toMatchObject({ tag: "locality", placeID: `wof:${SAVANNAH.id}` })
	})

	it("reads an unresolved country as the region of that name, as a US scope leaves Georgia", async () => {
		const roots = [node("locality", "Savannah", 0), node("country", "Georgia", 10)]

		await applyCountryAsRegion(roots, atlas)

		expect(roots[1]).toMatchObject({ tag: "region", placeID: `wof:${GEORGIA_STATE.id}` })
	})

	it("keeps the country when the country holds the town", async () => {
		const roots = [node("locality", "Tbilisi", 0), georgia()]

		await applyCountryAsRegion(roots, atlas)

		expect(roots[1]!.tag).toBe("country")
	})

	it("keeps the country when no region of that name holds the town", async () => {
		const roots = [node("locality", "Nowhere", 0), georgia()]

		await applyCountryAsRegion(roots, atlas)

		expect(roots[1]!.tag).toBe("country")
	})
})

describe("applyVenueAsTown", () => {
	const ROAD_TOWN: ResolvedPlace = { ...CITY, id: 421_199_000, name: "Road Town", country: "VG" }

	const territory = () =>
		node("country", "British Virgin Islands", 11, { placeID: "wof:85632161", metadata: { resolver_country: "VG" } })

	it("reads a venue as the town of that name in the stated country", async () => {
		const roots = [node("venue", "Road Town", 0), territory()]

		await applyVenueAsTown(roots, backendOf([ROAD_TOWN]))

		expect(roots[0]).toMatchObject({ tag: "locality", placeID: `wof:${ROAD_TOWN.id}` })
	})

	it("keeps the venue when the country's only match is a correction", async () => {
		const roots = [node("venue", "Roed Town", 0), territory()]

		await applyVenueAsTown(roots, backendOf([{ ...ROAD_TOWN, exactMatch: false }]))

		expect(roots[0]!.tag).toBe("venue")
	})

	it("keeps a venue that sits beside a street", async () => {
		const roots = [node("venue", "Road Town", 0), node("street", "Main Street", 11), territory()]

		await applyVenueAsTown(roots, backendOf([ROAD_TOWN]))

		expect(roots[0]!.tag).toBe("venue")
	})
})

describe("applyLocalityAsRegion", () => {
	const ATOLL: ResolvedPlace = {
		...EMPTY_PLACE_FIELDS,
		id: 85_681_000,
		name: "Likiep Atoll",
		placetype: "region",
		country: "MH",
		lat: 9.88333,
		lon: 169.15,
		score: 3,
		exactMatch: true,
	}

	it("reads an unresolved locality as the region of that name in the stated country", async () => {
		const roots = [node("locality", "Likiep Atoll", 0)]

		await applyLocalityAsRegion(roots, backendOf([ATOLL]), "MH")

		expect(roots[0]).toMatchObject({ tag: "region", lat: 9.88333 })
	})

	it("leaves a resolved locality", async () => {
		const roots = [node("locality", "Likiep Atoll", 0, { placeID: "wof:1" })]

		await applyLocalityAsRegion(roots, backendOf([ATOLL]), "MH")

		expect(roots[0]!.tag).toBe("locality")
	})

	it("leaves a locality when the region is in another country", async () => {
		const roots = [node("locality", "Likiep Atoll", 0)]

		await applyLocalityAsRegion(roots, backendOf([ATOLL]), "FM")

		expect(roots[0]!.tag).toBe("locality")
	})
})

describe("applyRegionCity", () => {
	it("reads a street address's region as the city of that name inside it", async () => {
		const roots = streetAddress()

		await applyRegionCity(roots, backendOf([CITY]))

		expect(roots[2]).toMatchObject({ tag: "locality", lat: 10.7737261, placeID: "wof:8962610550807" })
	})

	it("leaves a region that holds no such city", async () => {
		const roots = streetAddress()

		await applyRegionCity(roots, backendOf([]))

		expect(roots[2]).toMatchObject({ tag: "region", lat: 9.78361575 })
	})

	it("leaves a region when only an alias matches", async () => {
		const roots = streetAddress()

		await applyRegionCity(roots, backendOf([{ ...CITY, exactMatch: false }]))

		expect(roots[2]!.tag).toBe("region")
	})

	it("leaves a region when the name exists only outside it", async () => {
		const roots = streetAddress()

		await applyRegionCity(roots, backendOf([{ ...CITY, regionScopeMiss: true }]))

		expect(roots[2]!.tag).toBe("region")
	})

	it("leaves a bare region", async () => {
		const roots = [node("region", "Hồ Chí Minh", 0, { placeID: "wof:8638961045712" })]

		await applyRegionCity(roots, backendOf([CITY]))

		expect(roots[0]!.tag).toBe("region")
	})

	it("leaves an address whose stated locality resolved", async () => {
		const roots = [...streetAddress(), node("locality", "Quận 1", 30, { placeID: "wof:7" })]

		await applyRegionCity(roots, backendOf([CITY]))

		expect(roots[2]!.tag).toBe("region")
	})
})
