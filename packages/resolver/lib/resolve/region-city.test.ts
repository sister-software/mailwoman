/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyLocalityAsRegion, applyRegionCity } from "#resolve/region-city"

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

	it("leaves an address that states a locality", async () => {
		const roots = [...streetAddress(), node("locality", "Quận 1", 30)]

		await applyRegionCity(roots, backendOf([CITY]))

		expect(roots[2]!.tag).toBe("region")
	})
})
