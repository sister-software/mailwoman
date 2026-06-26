/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { countryFlag, countryReferenceAnnotator } from "./reference.js"

test("countryFlag: alpha-2 → regional-indicator emoji, case-insensitive", () => {
	expect(countryFlag("US")).toBe("🇺🇸")
	expect(countryFlag("us")).toBe("🇺🇸")
	expect(countryFlag("GB")).toBe("🇬🇧")
	expect(countryFlag("FR")).toBe("🇫🇷")
})

test("countryFlag: non-two-letter input → empty string", () => {
	expect(countryFlag("USA")).toBe("")
	expect(countryFlag("1")).toBe("")
	expect(countryFlag("")).toBe("")
})

test("countryReferenceAnnotator: fills iso3166 + flag from the country code", () => {
	expect(countryReferenceAnnotator({ lat: 0, lon: 0, countryCode: "us" })).toEqual({
		iso3166: { alpha2: "US" },
		flag: "🇺🇸",
	})
})

test("countryReferenceAnnotator: abstains without a valid country code", () => {
	expect(countryReferenceAnnotator({ lat: 0, lon: 0 })).toEqual({})
	expect(countryReferenceAnnotator({ lat: 0, lon: 0, countryCode: "USA" })).toEqual({})
})
