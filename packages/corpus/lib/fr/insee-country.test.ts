/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { countryOfInseeCode, INSEE_COUNTRIES } from "#fr/insee-country"

describe("countryOfInseeCode", () => {
	it.each([
		["97123", "GP"],
		["97216", "MQ"],
		["97390", "GF"],
		["97412", "RE"],
		["97501", "PM"],
		["97630", "YT"],
		["97701", "BL"],
		["97801", "MF"],
		["984", "TF"],
		["986", "WF"],
		["98735", "PF"],
		["98825", "NC"],
		// A metropolitan department is two characters, Corsica's included, and neither reads as overseas.
		["75101", "FR"],
		["2A004", "FR"],
		// Clipperton has no ISO 3166-1 alpha-2 code, so `989` stays metropolitan rather than guessing.
		["98901", "FR"],
		["", "FR"],
	])("reads %s as %s", (code, expected) => {
		expect(countryOfInseeCode(code)).toBe(expected)
	})

	it("reads a code whose publisher padded it", () => {
		expect(countryOfInseeCode(" 97216 ")).toBe("MQ")
	})

	it("every jurisdiction it can return is in the declared set", () => {
		const returned = new Set(
			[
				"97123",
				"97216",
				"97390",
				"97412",
				"97501",
				"97630",
				"97701",
				"97801",
				"984",
				"986",
				"98735",
				"98825",
				"75101",
			].map((code) => countryOfInseeCode(code))
		)

		for (const country of returned) {
			expect(INSEE_COUNTRIES).toContain(country)
		}
	})

	it("declares France beside every overseas jurisdiction", () => {
		expect(INSEE_COUNTRIES[0]).toBe("FR")
		expect(new Set(INSEE_COUNTRIES).size).toBe(INSEE_COUNTRIES.length)
	})
})
