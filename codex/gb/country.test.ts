/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { GB_COUNTRIES, isUkCountryCode, lookupUkCountry } from "./country.js"

describe("GB_COUNTRIES", () => {
	it("covers the four constituent countries of the UK", () => {
		expect(Object.keys(GB_COUNTRIES)).toHaveLength(4)
		expect(GB_COUNTRIES.ENG).toEqual({ code: "ENG", name: "England" })
		expect(GB_COUNTRIES.NIR.name).toBe("Northern Ireland")
	})
})

describe("isUkCountryCode", () => {
	it("accepts ISO 3166-2:GB codes, case-insensitively", () => {
		expect(isUkCountryCode("ENG")).toBe(true)
		expect(isUkCountryCode("sct")).toBe(true)
		expect(isUkCountryCode("BY")).toBe(false) // a German state, not a UK country
	})
})

describe("lookupUkCountry", () => {
	it("resolves ISO code and English name to the ISO code", () => {
		expect(lookupUkCountry("ENG")).toBe("ENG")
		expect(lookupUkCountry("England")).toBe("ENG")
		expect(lookupUkCountry("Scotland")).toBe("SCT")
		expect(lookupUkCountry("wales")).toBe("WLS")
		expect(lookupUkCountry("Northern Ireland")).toBe("NIR")
		expect(lookupUkCountry("northern-ireland")).toBe("NIR")
	})

	it("returns null for an unknown country", () => {
		expect(lookupUkCountry("Ireland")).toBeNull() // the Republic, not a UK country
		expect(lookupUkCountry("Bavaria")).toBeNull()
		expect(lookupUkCountry(null)).toBeNull()
	})
})
