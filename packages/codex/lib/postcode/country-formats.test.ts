/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { countryPostcodeFormat, matchCountryPostcode } from "#postcode/country-formats"
import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "#postcode/country-formats/data"

describe("matchCountryPostcode", () => {
	test("accepts the alphanumeric and seven-digit forms a four-to-six-digit rule refused", () => {
		expect(matchCountryPostcode("C1425ABC", "AR")).toBe("C1425ABC")
		expect(matchCountryPostcode("1425", "AR")).toBe("1425")
		expect(matchCountryPostcode("BS8811", "BN")).toBe("BS8811")
		expect(matchCountryPostcode("8320000", "CL")).toBe("8320000")
		expect(matchCountryPostcode("00907-1234", "PR")).toBe("00907-1234")
	})

	test("refuses a value outside the country's form", () => {
		expect(matchCountryPostcode("1234", "KZ")).toBeNull()
		expect(matchCountryPostcode("123456", "EG")).toBeNull()
		expect(matchCountryPostcode("not a code", "RS")).toBeNull()
	})

	test("removes the country-code prefix the layout prints itself", () => {
		expect(matchCountryPostcode("MD-2001", "MD")).toBe("2001")
		expect(matchCountryPostcode("md-2001", "md")).toBe("2001")
		expect(matchCountryPostcode("2001", "MD")).toBe("2001")
		expect(matchCountryPostcode("AX-22100", "AX")).toBe("22100")
	})

	test("matches nothing for a country that states no postcode", () => {
		expect(countryPostcodeFormat("AE")).toBeNull()
		expect(matchCountryPostcode("00000", "AE")).toBeNull()
	})

	test("every stated pattern compiles anchored", () => {
		for (const code of Object.keys(COUNTRY_POSTCODE_FORMAT_SOURCES)) {
			expect(countryPostcodeFormat(code)?.pattern).toBeInstanceOf(RegExp)
		}
	})
})
