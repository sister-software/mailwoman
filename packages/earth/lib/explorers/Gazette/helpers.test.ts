/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	type GazetteerCodes,
	groupByNameKey,
	type PlaceRow,
	prefixUpperBound,
	resolverReading,
	rowFromRecord,
	spelunkerURL,
	tagsSelecting,
} from "#explorers/Gazette/helpers"

const codes: GazetteerCodes = {
	countries: new Map([
		[8, "GB"],
		[11, "US"],
	]),
	placetypes: new Map([
		[1, "region"],
		[3, "locality"],
		[10, "borough"],
	]),
}

function row(overrides: Partial<PlaceRow>): PlaceRow {
	return {
		nameKey: "london",
		country: "GB",
		regionID: 1_880_762_729,
		placetype: "locality",
		negRank: -6.9,
		sprID: 101_750_367,
		name: "London",
		latitude: 51.5,
		longitude: -0.1,
		bbox: null,
		population: 8_799_728,
		isPrimary: true,
		importance: 0.93,
		nameRole: null,
		...overrides,
	}
}

describe("gazette helpers", () => {
	it("rowFromRecord resolves the code columns and reads a bbox only when all four edges are present", () => {
		const place = rowFromRecord(
			{
				name_key: "london",
				country_id: 8,
				region_id: 1_880_762_729,
				placetype_id: 3,
				neg_rank: -6.944,
				spr_id: 101_750_367,
				name: "London",
				latitude: 51.509648,
				longitude: -0.099076,
				min_lat: 51.28,
				min_lon: -0.51,
				max_lat: 51.69,
				max_lon: 0.33,
				population: 8_799_728,
				is_primary: 1,
				importance: 0.9359,
				name_role: null,
			},
			codes
		)

		expect(place.country).toBe("GB")
		expect(place.placetype).toBe("locality")
		expect(place.bbox).toEqual([-0.51, 51.28, 0.33, 51.69])
		expect(place.isPrimary).toBe(true)
		expect(place.nameRole).toBeNull()

		const unknown = rowFromRecord({ country_id: 999, placetype_id: 77, min_lat: 1, min_lon: null }, codes)

		expect(unknown.country).toBe("#999")
		expect(unknown.placetype).toBe("#77")
		expect(unknown.bbox).toBeNull()
	})

	it("groupByNameKey keeps key order, counts the places under a key and faces each key with its lowest rank", () => {
		const groups = groupByNameKey([
			row({ nameKey: "london", negRank: -5.6, sprID: 1, name: "London, Ontario" }),
			row({ nameKey: "london", negRank: -6.9, sprID: 2, name: "London" }),
			row({ nameKey: "londonderry", negRank: -4, sprID: 3, name: "Londonderry" }),
			row({ nameKey: "london", negRank: -4, sprID: 4, name: "London, Ohio" }),
		])

		expect(groups.map((group) => [group.nameKey, group.count, group.top.sprID])).toEqual([
			["london", 3, 2],
			["londonderry", 1, 3],
		])
	})

	it("tagsSelecting answers the parse tags whose filter admits a placetype", () => {
		expect(tagsSelecting("borough")).toEqual(["locality", "dependent_locality", "municipality", "district"])
		expect(tagsSelecting("macroregion")).toEqual(["region", "prefecture"])
		expect(tagsSelecting("postalcode")).toEqual(["postcode"])
		expect(tagsSelecting("microhood")).toEqual([])
	})

	it("resolverReading reports the key, the admitting tags, the referential and the exact-match flag", () => {
		const reading = resolverReading(row({ placetype: "borough", population: 0, isPrimary: false }))

		expect(reading.nameKey).toBe("london")
		expect(reading.selectedByTags).toContain("locality")
		expect(reading.referential).toBe(0)
		expect(reading.exactMatch).toBe(false)

		expect(resolverReading(row({})).referential).toBeGreaterThan(0)
	})

	it("prefixUpperBound and spelunkerURL are what the range and the link read", () => {
		expect("london" < prefixUpperBound("londo")).toBe(true)
		expect("lone" < prefixUpperBound("londo")).toBe(false)
		expect(spelunkerURL(1_880_762_729)).toBe("https://spelunker.whosonfirst.org/id/1880762729/")
	})
})
