/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #928: `countryFromPostcodeFormat` — a parsed postcode's FORMAT as a country signal, used by the
 *   `postcodeCountryPrior` lever to override the language-based placer (which conflates GB/US). The
 *   essential guarantee: the GB pattern is UNFORGEABLE across the formats we resolve — it never matches
 *   a US ZIP, an NL `\d{4} [A-Z]{2}`, an FR 5-digit, or a Canadian `A#A #A#` code — so turning the lever
 *   on can never mis-route a non-GB address.
 */

import { describe, expect, it } from "vitest"

import { countryFromPostcodeFormat } from "./geocode-core.js"

describe("countryFromPostcodeFormat (#928)", () => {
	it("matches GB postcodes (spaced and unspaced)", () => {
		expect(countryFromPostcodeFormat("E4 9AZ")).toBe("GB")
		expect(countryFromPostcodeFormat("SW1A 1AA")).toBe("GB")
		expect(countryFromPostcodeFormat("IG5 0NA")).toBe("GB")
		expect(countryFromPostcodeFormat("E49AZ")).toBe("GB") // unspaced
		expect(countryFromPostcodeFormat("  CH43 0TR  ")).toBe("GB") // trimmed
	})

	it("matches CA postcodes (A#A #A#), distinct from GB", () => {
		expect(countryFromPostcodeFormat("K2P 1L4")).toBe("CA")
		expect(countryFromPostcodeFormat("M5J 2J2")).toBe("CA")
		expect(countryFromPostcodeFormat("V6C0C3")).toBe("CA") // unspaced
	})

	it("does NOT match a US ZIP, NL, or FR postcode (unforgeable → no mis-route)", () => {
		expect(countryFromPostcodeFormat("90210")).toBeNull() // US ZIP (all digits)
		expect(countryFromPostcodeFormat("1012 LG")).toBeNull() // NL (digits-first)
		expect(countryFromPostcodeFormat("75013")).toBeNull() // FR
	})

	it("matches IE Eircodes (routing key + 4-alnum unique part), incl. the D6W special", () => {
		expect(countryFromPostcodeFormat("D02 AF30")).toBe("IE")
		expect(countryFromPostcodeFormat("T12 X70A")).toBe("IE")
		expect(countryFromPostcodeFormat("V94T2XR")).toBe("IE") // unspaced
		expect(countryFromPostcodeFormat("D6W XY00")).toBe("IE")
	})

	it("GB / CA / IE formats never collide", () => {
		// GB inward is 3 chars (\d[A-Z]{2}); CA ends \d[A-Z]\d; IE unique part is 4 alnum. Mutually exclusive.
		expect(countryFromPostcodeFormat("E4 9AZ")).toBe("GB")
		expect(countryFromPostcodeFormat("K2P 1L4")).toBe("CA")
		expect(countryFromPostcodeFormat("D02 AF30")).toBe("IE")
		// Belfast (Northern Ireland) uses GB postcodes — BT must stay GB, never IE.
		expect(countryFromPostcodeFormat("BT1 5GS")).toBe("GB")
	})

	it("is null on empty / missing input", () => {
		expect(countryFromPostcodeFormat(undefined)).toBeNull()
		expect(countryFromPostcodeFormat("")).toBeNull()
		expect(countryFromPostcodeFormat("   ")).toBeNull()
	})
})
