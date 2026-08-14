/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { countryOfPostcode, countryOfPostcodeArea, GB_POSTCODE_AREA_COUNTRY } from "./postcode-area.ts"

describe("GB_POSTCODE_AREA_COUNTRY", () => {
	it("maps the explicit non-England areas to their country", () => {
		expect(GB_POSTCODE_AREA_COUNTRY.BT).toBe("NIR") // Belfast → Northern Ireland
		expect(GB_POSTCODE_AREA_COUNTRY.EH).toBe("SCT") // Edinburgh → Scotland
		expect(GB_POSTCODE_AREA_COUNTRY.G).toBe("SCT") // Glasgow → Scotland
		expect(GB_POSTCODE_AREA_COUNTRY.CF).toBe("WLS") // Cardiff → Wales
	})

	it("assigns the border-straddling areas to their majority country", () => {
		expect(GB_POSTCODE_AREA_COUNTRY.TD).toBe("SCT") // Galashiels — majority Scotland
		expect(GB_POSTCODE_AREA_COUNTRY.SY).toBe("WLS") // Shrewsbury — majority Wales
	})

	it("does not list England — it is the transparent default", () => {
		expect(GB_POSTCODE_AREA_COUNTRY.SW).toBeUndefined()
		expect(GB_POSTCODE_AREA_COUNTRY.M).toBeUndefined()
	})
})

describe("countryOfPostcodeArea", () => {
	it("returns the explicit country for a known non-England area", () => {
		expect(countryOfPostcodeArea("BT")).toBe("NIR")
		expect(countryOfPostcodeArea("EH")).toBe("SCT")
		expect(countryOfPostcodeArea("CF")).toBe("WLS")
	})

	it("defaults a validly-shaped unknown area to England", () => {
		expect(countryOfPostcodeArea("SW")).toBe("ENG")
		expect(countryOfPostcodeArea("M")).toBe("ENG")
		expect(countryOfPostcodeArea("ox")).toBe("ENG") // case-insensitive
	})

	it("returns null for clearly-invalid input (not one-or-two letters)", () => {
		expect(countryOfPostcodeArea("123")).toBeNull()
		expect(countryOfPostcodeArea("LONG")).toBeNull()
		expect(countryOfPostcodeArea("")).toBeNull()
		expect(countryOfPostcodeArea(null)).toBeNull()
	})
})

describe("countryOfPostcode", () => {
	it("resolves a whole postcode through its area to a constituent country", () => {
		expect(countryOfPostcode("BT1 1AA")).toBe("NIR")
		expect(countryOfPostcode("EH1 1BB")).toBe("SCT")
		expect(countryOfPostcode("CF10 1AA")).toBe("WLS")
		expect(countryOfPostcode("SW1A 1AA")).toBe("ENG")
		expect(countryOfPostcode("M1 1AE")).toBe("ENG")
	})

	it("returns null when no postcode area can be extracted", () => {
		expect(countryOfPostcode("12345")).toBeNull()
		expect(countryOfPostcode(null)).toBeNull()
	})

	it("area→country is a real mapping, but a postcode is not a county", () => {
		// London (`SW`) and Manchester (`M`) are different cities in different English counties, yet
		// both resolve to ENG — the area→country map is genuine. But that is as far as it goes: the
		// postcode carries the COUNTRY, never the county, while a Scottish area like Glasgow's `G`
		// flips the country outright. Royal Mail routing, not administrative geography.
		expect(countryOfPostcode("SW1A 1AA")).toBe("ENG") // London
		expect(countryOfPostcode("M1 1AE")).toBe("ENG") // Manchester
		expect(countryOfPostcode("G1 1XW")).toBe("SCT") // Glasgow
	})
})
