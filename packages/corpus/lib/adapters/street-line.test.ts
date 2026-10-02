/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { composeHouseNumber, splitStreetLine } from "#adapters/street-line"

describe("splitStreetLine", () => {
	it("splits a standard urban address into house_number + street", () => {
		expect(splitStreetLine("123 Main St")).toEqual({ house_number: "123", street: "Main St" })
	})

	it("preserves directional prefixes inside the street component", () => {
		expect(splitStreetLine("6450 W Indian School Rd")).toEqual({
			house_number: "6450",
			street: "W Indian School Rd",
		})
	})

	it("recognizes a single trailing letter on the house number", () => {
		expect(splitStreetLine("101A Main St")).toEqual({ house_number: "101A", street: "Main St" })
	})

	it("recognizes hyphenated house numbers (NYC garden-apartment style)", () => {
		expect(splitStreetLine("40-12 Bell Blvd")).toEqual({ house_number: "40-12", street: "Bell Blvd" })
	})

	it("returns street-only for shapes lacking a leading digit", () => {
		expect(splitStreetLine("PO Box 1234")).toEqual({ street: "PO Box 1234" })
		expect(splitStreetLine("RR 2 Box 67")).toEqual({ street: "RR 2 Box 67" })
	})

	it("returns null for empty or whitespace-only input", () => {
		expect(splitStreetLine("")).toBeNull()
		expect(splitStreetLine("   ")).toBeNull()
	})
})

describe("composeHouseNumber", () => {
	it("joins with no separator, as Kartverket writes 12B", () => {
		expect(composeHouseNumber("12", "B")).toBe("12B")
	})

	it("joins with a space, as BAN writes 10 bis", () => {
		expect(composeHouseNumber("10", "bis", " ")).toBe("10 bis")
	})

	it("returns the number alone when the suffix column is empty", () => {
		expect(composeHouseNumber("45", "", " ")).toBe("45")
		expect(composeHouseNumber("45", "   ", " ")).toBe("45")
	})

	it("trims a publisher's padding off both columns", () => {
		expect(composeHouseNumber(" 10 ", " bis ", " ")).toBe("10 bis")
	})

	it("returns an empty string when the number column is empty, so a caller omits house_number", () => {
		expect(composeHouseNumber("", "bis", " ")).toBe("")
		expect(composeHouseNumber("   ", "", " ")).toBe("")
	})
})
