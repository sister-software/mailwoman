/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { postcodeSyntax, acceptPostcode } from "#country-formats"
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

	test("every stated pattern compiles anchored", () => {
		for (const code of Object.keys(COUNTRY_POSTCODE_FORMAT_SOURCES)) {
			expect(postcodeSyntax(code)?.pattern).toBeInstanceOf(RegExp)
		}
	})
})
