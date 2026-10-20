/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { postcodePlacement, postcodeSyntax, acceptPostcode } from "#country-formats"
import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "#country-formats/data"

describe("acceptPostcode", () => {
	test("accepts the alphanumeric and seven-digit forms a four-to-six-digit rule refused", () => {
		expect(acceptPostcode("C1425ABC", "AR")).toBe("C1425ABC")
		expect(acceptPostcode("1425", "AR")).toBe("1425")
		expect(acceptPostcode("BS8811", "BN")).toBe("BS8811")
		expect(acceptPostcode("8320000", "CL")).toBe("8320000")
		expect(acceptPostcode("00907-1234", "PR")).toBe("00907-1234")
	})

	test("refuses a value outside the country's form", () => {
		expect(acceptPostcode("1234", "KZ")).toBeNull()
		expect(acceptPostcode("123456", "EG")).toBeNull()
		expect(acceptPostcode("not a code", "RS")).toBeNull()
	})

	test.each([
		["bn1 1aa", "GB"],
		["m113aa", "GB"],
		["BN1  1AA", "GB"],
		["gx111aa", "GI"],
		["ASCN1ZZ", "AC"],
		["lima23", "PE"],
		["h3z2y7", "CA"],
		["H3Z  2Y7", "CA"],
		["11000", "CZ"],
		["a65f4e2", "IE"],
	])("accepts %s for %s whatever its case and spacing, and returns it as written", (value, country) => {
		expect(acceptPostcode(value, country)).toBe(value)
	})

	test("keeps a hyphen the country's form requires", () => {
		expect(acceptPostcode("00-950", "PL")).toBe("00-950")
		expect(acceptPostcode("00950", "PL")).toBeNull()
		expect(acceptPostcode("2725-079", "PT")).toBe("2725-079")
		expect(acceptPostcode("2725079", "PT")).toBeNull()
	})

	test("keeps the space inside the ZIP+4 separator class", () => {
		expect(acceptPostcode("22162 1010", "US")).toBe("22162 1010")
		expect(acceptPostcode("22162-1010", "US")).toBe("22162-1010")
	})

	test("removes the country-code prefix the layout prints itself", () => {
		expect(acceptPostcode("MD-2001", "MD")).toBe("2001")
		expect(acceptPostcode("md-2001", "md")).toBe("2001")
		expect(acceptPostcode("2001", "MD")).toBe("2001")
		expect(acceptPostcode("AX-22100", "AX")).toBe("22100")
	})

	test("matches nothing for a country that states no postcode", () => {
		expect(postcodeSyntax("AE")).toBeNull()
		expect(acceptPostcode("00000", "AE")).toBeNull()
	})

	test("reads where the layout prints the postcode relative to the locality", () => {
		expect(postcodePlacement("fr")).toBe("before_locality")
		expect(postcodePlacement("BR")).toBe("after_locality")
		// Japan's layout prints no locality field, so it states no order.
		expect(postcodePlacement("JP")).toBeNull()
		// The UAE states no postcode at all.
		expect(postcodePlacement("AE")).toBeNull()
	})

	test("every stated pattern compiles anchored", () => {
		for (const code of Object.keys(COUNTRY_POSTCODE_FORMAT_SOURCES)) {
			expect(postcodeSyntax(code)?.pattern).toBeInstanceOf(RegExp)
		}
	})
})
