import { isZipCode, StateAbbreviationZipCodePrefixRecord, US_STATE_BY_ABBREVIATION } from "@mailwoman/codex/us"
import { describe, expect, it } from "vitest"

import { usAbbrevRegions } from "#us/abbrev/regions"
import { US_STATE_CODES_READ_AS_COUNTRIES } from "#us/state-country-codes"

describe("usAbbrevRegions (#2769)", () => {
	const regions = usAbbrevRegions()
	const byCode = new Map(regions.map((region) => [region.code, region]))

	it("returns one entry per computed state code, in the codex's order", () => {
		expect(regions.map((region) => region.code)).toEqual([...US_STATE_CODES_READ_AS_COUNTRIES])
	})

	it("names each state as the codex does", () => {
		for (const region of regions) {
			expect(region.name).toBe(US_STATE_BY_ABBREVIATION[region.code])
		}
	})

	it("pairs every locality with a five-digit postcode whose leading digit the codex assigns to that state", () => {
		for (const region of regions) {
			expect(region.localities.length, region.code).toBeGreaterThanOrEqual(2)
			expect(region.postcodes, region.code).toHaveLength(region.localities.length)

			for (const postcode of region.postcodes) {
				expect(isZipCode(postcode), `${region.code} ${postcode}`).toBe(true)

				expect(Number(postcode[0]), `${region.code} ${postcode}`).toBe(
					StateAbbreviationZipCodePrefixRecord[region.code]
				)
			}
		}
	})

	it("keeps the pairs the hand-typed table carried for California", () => {
		expect(byCode.get("CA")?.localities).toContain("Los Angeles")
	})
})
