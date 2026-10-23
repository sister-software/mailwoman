import { CountryISO2 } from "@mailwoman/codex/country"
import { US_STATE_ABBREVIATIONS, US_TERRITORY_ABBREVIATIONS } from "@mailwoman/codex/us"
import { describe, expect, it } from "vitest"

import { US_STATE_CODES_READ_AS_COUNTRIES } from "#us/state-country-codes"

const COUNTRY_CODES = new Set<string>(Object.values(CountryISO2))

describe("US_STATE_CODES_READ_AS_COUNTRIES (#2769)", () => {
	it("holds every USPS code that is also another country's alpha-2 code, and no other", () => {
		const expected = US_STATE_ABBREVIATIONS.filter(
			(code) => COUNTRY_CODES.has(code) && !(US_TERRITORY_ABBREVIATIONS as readonly string[]).includes(code)
		)

		expect([...US_STATE_CODES_READ_AS_COUNTRIES]).toEqual(expected)
	})

	it("leaves out the territories, each of which is the same place under both readings", () => {
		for (const territory of US_TERRITORY_ABBREVIATIONS) {
			expect(COUNTRY_CODES.has(territory), territory).toBe(true)
			expect(US_STATE_CODES_READ_AS_COUNTRIES).not.toContain(territory)
		}
	})

	it("covers the six states the recipe used to type by hand", () => {
		for (const code of ["CA", "GA", "IN", "MA", "PA", "AL"]) {
			expect(US_STATE_CODES_READ_AS_COUNTRIES, code).toContain(code)
		}
	})
})
