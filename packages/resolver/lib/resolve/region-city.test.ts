/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import {
	applyCountryAsRegion,
	applyLocalityAsRegion,
	applyRegionCity,
	applyStreetAsTown,
	applyVenueAsTown,
} from "#resolve/region-city"

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

describe("applyRegionCity with a resolved district", () => {
	const HAMBURG = {
		...CITY,
		id: 101_748_175,
		name: "Hamburg",
		country: "DE",
		lat: 53.55,
		lon: 10,
		bbox: { minLat: 53.39, maxLat: 53.74, minLon: 9.73, maxLon: 10.33 },
	}

	it("reads the region as its city when a district sits beside it, and lets the district answer", async () => {
		const roots = [
			node("dependent_locality", "Altona", 0, { placeID: "wof:1847524011", lat: 53.577, lon: 9.876 }),
			node("region", "Hamburg", 8, { placeID: "wof:85682505" }),
		]

		await applyRegionCity(roots, backendOf([HAMBURG]))

		expect(roots[1]).toMatchObject({ tag: "locality", placeID: "wof:101748175" })
		expect(roots[0]!.metadata).toMatchObject({ contained_by_parent: true })
	})

	it("keeps a bare region beside an unresolved district", async () => {
		const roots = [node("dependent_locality", "Nowhere", 0), node("region", "Hamburg", 9, { placeID: "wof:85682505" })]

		await applyRegionCity(roots, backendOf([HAMBURG]))

		expect(roots[1]!.tag).toBe("region")
	})
})

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

describe("applyStreetAsTown", () => {
	const CROCKETTS_BLUFF = {
		...CITY,
		id: 1_243_286_477,
		name: "Crocketts Bluff",
		country: "US",
		lat: 34.44399,
		lon: -91.22012,
	}

	const postcodeAt = (lat: number, lon: number) =>
		node("postcode", "72038", 20, { placeID: "wof:554741891", lat, lon, metadata: { resolver_country: "US" } })

	const unnumbered = (lat: number, lon: number) => [
		node("street", "Crocketts", 0),
		node("street_suffix", "Bluff", 10),
		node("region", "AR", 17, { placeID: "wof:85688585" }),
		postcodeAt(lat, lon),
	]

	it("reads the street's spans as the town that holds the postcode", async () => {
		const roots = unnumbered(34.446308, -91.243804)

		await applyStreetAsTown(roots, backendOf([CROCKETTS_BLUFF]))

		expect(roots.map(({ tag, value }) => `${tag}:${value}`)).toEqual([
			"locality:Crocketts Bluff",
			"region:AR",
			"postcode:72038",
		])

		expect(roots[0]).toMatchObject({ end: 15, lat: CROCKETTS_BLUFF.lat, placeID: "wof:1243286477" })
	})

	it("keeps the street when the town sits far from the postcode", async () => {
		const roots = unnumbered(36, -94)

		await applyStreetAsTown(roots, backendOf([CROCKETTS_BLUFF]))

		expect(roots[0]!.tag).toBe("street")
	})

	it("keeps a numbered street", async () => {
		const roots = [node("house_number", "12", 0), ...unnumbered(34.446308, -91.243804)]

		await applyStreetAsTown(roots, backendOf([CROCKETTS_BLUFF]))

		expect(roots[1]!.tag).toBe("street")
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

	it("reads each form of a slash-doubled name until one names a town", async () => {
		const DERRY: ResolvedPlace = { ...CITY, id: 101_752_123, name: "Derry", country: "GB" }
		const asked: string[] = []

		const backend: ResolverBackend = {
			findPlace: async ({ text }) => {
				asked.push(text)

				return text === "Londonderry" ? [DERRY] : [{ ...DERRY, exactMatch: false }]
			},
		}

		const roots = [
			node("venue", "Derry/Londonderry", 0),
			node("country", "United Kingdom", 19, { placeID: "wof:85633159", metadata: { resolver_country: "GB" } }),
		]

		await applyVenueAsTown(roots, backend)

		expect(asked).toEqual(["Derry/Londonderry", "Derry", "Londonderry"])
		expect(roots[0]).toMatchObject({ tag: "locality", placeID: `wof:${DERRY.id}` })
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
