/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { composeHouseNumber, splitStreetLine, splitTrailingStreetLine } from "#adapters/street-line"

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

describe("splitTrailingStreetLine", () => {
	it("splits a number-last line into street + house_number", () => {
		expect(splitTrailingStreetLine("VIA GIUSEPPE GARIBALDI 75")).toEqual({
			house_number: "75",
			street: "VIA GIUSEPPE GARIBALDI",
		})
	})

	it("accepts a comma between the street and the number", () => {
		expect(splitTrailingStreetLine("VIA INDIPENDENZA, 41")).toEqual({ house_number: "41", street: "VIA INDIPENDENZA" })
		expect(splitTrailingStreetLine("SANTA CROCE,489")).toEqual({ house_number: "489", street: "SANTA CROCE" })
	})

	it("keeps a subdivided number whole and closes up its separator", () => {
		expect(splitTrailingStreetLine("VIA PASTRENGO 2/TER")).toEqual({ house_number: "2/TER", street: "VIA PASTRENGO" })

		expect(splitTrailingStreetLine("VIA FILIPPO PALUMBO 16/18")).toEqual({
			house_number: "16/18",
			street: "VIA FILIPPO PALUMBO",
		})

		expect(splitTrailingStreetLine("VIA PERUGIA 2 / A")).toEqual({ house_number: "2/A", street: "VIA PERUGIA" })
	})

	it("recognizes a single letter written against the number", () => {
		expect(splitTrailingStreetLine("VIA TERME DI TRAIANO 39A")).toEqual({
			house_number: "39A",
			street: "VIA TERME DI TRAIANO",
		})
	})

	it("collapses a publisher's inner whitespace", () => {
		expect(splitTrailingStreetLine("VIA  CONSOLATO DEL MARE 41")).toEqual({
			house_number: "41",
			street: "VIA CONSOLATO DEL MARE",
		})
	})

	it("returns street-only for a line that ends in anything but a number", () => {
		expect(splitTrailingStreetLine("PIAZZA CASTELLO")).toEqual({ street: "PIAZZA CASTELLO" })
		expect(splitTrailingStreetLine("VIALE ROMA SNC")).toEqual({ street: "VIALE ROMA SNC" })
	})

	it("requires a separator, so a digit written against the street name stays in it", () => {
		expect(splitTrailingStreetLine("VIA SALARIA3")).toEqual({ street: "VIA SALARIA3" })
	})

	it("returns null for empty or whitespace-only input", () => {
		expect(splitTrailingStreetLine("")).toBeNull()
		expect(splitTrailingStreetLine("   ")).toBeNull()
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
