/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyCountryCode, readRegionCodeAsCountry, writtenCountryCode } from "#resolve/country-code"

const RUSSIA: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 85_632_685,
	name: "Russia",
	placetype: "country",
	country: "RU",
	lat: 61,
	lon: 97,
	score: 8,
	exactMatch: true,
}

function node(tag: string, value: string, start: number): AddressNode {
	return { tag, value, start, end: start + value.length, confidence: 0.9, children: [] } as AddressNode
}

const backendOf = (places: ResolvedPlace[]): ResolverBackend => ({ findPlace: async () => places })

describe("writtenCountryCode", () => {
	it.each([
		["USA", "US"],
		["RUS", "RU"],
		["RMI", "MH"],
		["UAE", "AE"],
		["U.A.E.", "AE"],
		["PNG", "PG"],
		["AUS", "AU"],
		["HND", "HN"],
		["MEX", "MX"],
		["CAN", "CA"],
		["GER", "DE"],
	])("reads %s, ahead of any airport holding the code", (written, iso2) => {
		expect(writtenCountryCode(written)).toBe(iso2)
	})

	it.each(["Usa", "CA", "IN", "DTW", "SFO", "LHR", "Russia"])("reads %s as no country code", (written) => {
		expect(writtenCountryCode(written)).toBeNull()
	})
})

describe("readRegionCodeAsCountry", () => {
	const tree = (...roots: AddressNode[]): AddressTree => ({ raw: "", roots })

	it("reads a region code as the country on a copy", () => {
		const input = tree(node("locality", "Likiep Atoll", 0), node("region", "RMI", 14))
		const read = readRegionCodeAsCountry(input)

		expect(read.roots[1]!.tag).toBe("country")
		expect(input.roots[1]!.tag).toBe("region")
	})

	it("leaves a region written as an ISO code", () => {
		const input = tree(node("locality", "Fort Wayne", 0), node("region", "IND", 12))

		expect(readRegionCodeAsCountry(input)).toBe(input)
	})

	it("leaves a tree that states a country", () => {
		const input = tree(node("region", "RMI", 0), node("country", "Marshall Islands", 5))

		expect(readRegionCodeAsCountry(input)).toBe(input)
	})
})

describe("applyCountryCode", () => {
	it("replaces another reading of the whole input with the country", async () => {
		const roots = [node("venue", "RUS", 0)]

		await applyCountryCode(roots, "RUS", backendOf([RUSSIA]))

		expect(roots).toHaveLength(1)
		expect(roots[0]).toMatchObject({ tag: "country", value: "RUS", placeID: "wof:85632685" })
	})

	it("leaves the parse when the gazetteer holds no such country", async () => {
		const roots = [node("venue", "RUS", 0)]

		await applyCountryCode(roots, "RUS", backendOf([{ ...RUSSIA, country: "BY" }]))

		expect(roots[0]!.tag).toBe("venue")
	})

	it("leaves an input with more than the code", async () => {
		const roots = [node("venue", "FRA", 0), node("country", "Germany", 5)]

		await applyCountryCode(roots, "FRA, Germany", backendOf([RUSSIA]))

		expect(roots).toHaveLength(2)
	})
})
