/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { inwardCode, isUkPostcode, normalizeUkPostcode, outwardCode, postcodeArea } from "./postcode.js"

describe("normalizeUkPostcode", () => {
	it("uppercases and inserts the single canonical space before the inward 3 chars", () => {
		expect(normalizeUkPostcode("sw1a1aa")).toBe("SW1A 1AA")
		expect(normalizeUkPostcode("M11AE")).toBe("M1 1AE")
		expect(normalizeUkPostcode("b33 8th")).toBe("B33 8TH")
		expect(normalizeUkPostcode(" CR2  6XH ")).toBe("CR2 6XH")
		expect(normalizeUkPostcode("dn551pt")).toBe("DN55 1PT")
	})

	it("returns null for non-postcodes", () => {
		expect(normalizeUkPostcode("75008")).toBeNull() // a French code postal
		expect(normalizeUkPostcode("ABC")).toBeNull()
		expect(normalizeUkPostcode("")).toBeNull()
		expect(normalizeUkPostcode(12345)).toBeNull()
	})
})

describe("isUkPostcode", () => {
	it("accepts valid postcodes (spaced or not)", () => {
		expect(isUkPostcode("SW1A 1AA")).toBe(true)
		expect(isUkPostcode("M1 1AE")).toBe(true)
		expect(isUkPostcode("B338TH")).toBe(true) // space optional
		expect(isUkPostcode("nonsense")).toBe(false)
	})
})

describe("outwardCode / inwardCode — the outward + inward split", () => {
	it("cleaves the outward (area + district) from the inward (sector + unit)", () => {
		expect(outwardCode("SW1A 1AA")).toBe("SW1A")
		expect(inwardCode("SW1A 1AA")).toBe("1AA")
		expect(outwardCode("M1 1AE")).toBe("M1")
		expect(inwardCode("M1 1AE")).toBe("1AE")
		expect(outwardCode("DN55 1PT")).toBe("DN55")
		expect(inwardCode("DN55 1PT")).toBe("1PT")
	})

	it("normalizes an un-spaced input before cleaving", () => {
		expect(outwardCode("sw1a1aa")).toBe("SW1A")
		expect(inwardCode("sw1a1aa")).toBe("1AA")
	})

	it("returns null for an invalid postcode", () => {
		expect(outwardCode("nope")).toBeNull()
		expect(inwardCode("nope")).toBeNull()
	})
})

describe("postcodeArea — the leading 1-2 letters", () => {
	it("extracts the Royal Mail area, stripping the district digits", () => {
		expect(postcodeArea("SW1A 1AA")).toBe("SW")
		expect(postcodeArea("B33 8TH")).toBe("B")
		expect(postcodeArea("EH1 1BB")).toBe("EH")
		expect(postcodeArea("M1 1AE")).toBe("M")
		expect(postcodeArea("DN55 1PT")).toBe("DN")
	})

	it("returns null for an invalid postcode", () => {
		expect(postcodeArea("12345")).toBeNull()
	})
})
