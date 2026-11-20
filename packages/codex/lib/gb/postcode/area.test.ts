// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { countryOfPostcode, countryOfPostcodeArea } from "#gb"

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
		// London (`SW`) and Manchester (`M`) are different cities in different
		// English counties, yet both resolve to ENG.
		// The area-to-country map holds.
		// It goes no further: the postcode identifies the country, never the county,
		// while a Scottish area like Glasgow's `G` changes the country.
		// Royal Mail routing rather than administrative geography.
		expect(countryOfPostcode("SW1A 1AA")).toBe("ENG") // London
		expect(countryOfPostcode("M1 1AE")).toBe("ENG") // Manchester
		expect(countryOfPostcode("G1 1XW")).toBe("SCT") // Glasgow
	})
})
