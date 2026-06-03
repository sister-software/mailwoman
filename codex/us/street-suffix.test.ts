/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import {
	isStreetSuffix,
	isStreetSuffixToken,
	lookupStreetSuffix,
	matchCase,
	matchTrailingSuffix,
	US_STREET_SUFFIX_LOOKUP,
	US_STREET_SUFFIX_PREFERRED_ABBR,
} from "./street-suffix.js"

describe("US_STREET_SUFFIX_LOOKUP", () => {
	it("maps canonical, full-word, and abbreviated variants to the canonical key", () => {
		expect(US_STREET_SUFFIX_LOOKUP.get("street")).toBe("STREET")
		expect(US_STREET_SUFFIX_LOOKUP.get("st")).toBe("STREET")
		expect(US_STREET_SUFFIX_LOOKUP.get("strt")).toBe("STREET")
		expect(US_STREET_SUFFIX_LOOKUP.get("trl")).toBe("TRAIL") // the abbreviation the inline list missed
		expect(US_STREET_SUFFIX_LOOKUP.get("blvd")).toBe("BOULEVARD")
	})

	it("does not know unrelated words", () => {
		expect(US_STREET_SUFFIX_LOOKUP.has("springfield")).toBe(false)
		expect(US_STREET_SUFFIX_LOOKUP.has("90210")).toBe(false)
	})
})

describe("US_STREET_SUFFIX_PREFERRED_ABBR", () => {
	it("returns the preferred USPS abbreviation per canonical", () => {
		expect(US_STREET_SUFFIX_PREFERRED_ABBR.STREET).toBe("ST")
		expect(US_STREET_SUFFIX_PREFERRED_ABBR.AVENUE).toBe("AVE")
		expect(US_STREET_SUFFIX_PREFERRED_ABBR.TRAIL).toBe("TRL")
	})
})

describe("matchTrailingSuffix", () => {
	it("matches the trailing suffix word of a street", () => {
		expect(matchTrailingSuffix("Outback Trl")).toEqual({ canonical: "TRAIL", matched: "Trl" })
		expect(matchTrailingSuffix("123 Main Street")).toEqual({ canonical: "STREET", matched: "Street" })
	})

	it("returns null when the trailing word is not a suffix", () => {
		expect(matchTrailingSuffix("Broadway")).toBeNull()
		expect(matchTrailingSuffix("")).toBeNull()
	})
})

describe("matchCase", () => {
	it("mirrors the reference word's case pattern onto the target", () => {
		expect(matchCase("AVENUE", "AVE")).toBe("AVENUE")
		expect(matchCase("AVENUE", "ave")).toBe("avenue")
		expect(matchCase("AVENUE", "Ave")).toBe("Avenue")
	})
})

describe("lookupStreetSuffix", () => {
	it("resolves a variant to its canonical + preferred abbreviation", () => {
		expect(lookupStreetSuffix("Boulevard")).toEqual({ suffix: "BOULEVARD", abbreviation: "BLVD" })
		expect(lookupStreetSuffix("blvd")).toEqual({ suffix: "BOULEVARD", abbreviation: "BLVD" })
	})

	it("returns null for an unknown or empty input", () => {
		expect(lookupStreetSuffix("broadway")).toBeNull()
		expect(lookupStreetSuffix(null)).toBeNull()
	})
})

describe("isStreetSuffix / isStreetSuffixToken", () => {
	it("isStreetSuffix is true only for canonical uppercase words", () => {
		expect(isStreetSuffix("STREET")).toBe(true)
		expect(isStreetSuffix("street")).toBe(false) // canonical is uppercase
		expect(isStreetSuffix("ST")).toBe(false) // an abbreviation, not the canonical
	})

	it("isStreetSuffixToken is true for any case-insensitive variant or abbreviation", () => {
		expect(isStreetSuffixToken("Street")).toBe(true)
		expect(isStreetSuffixToken("st")).toBe(true)
		expect(isStreetSuffixToken("Trl")).toBe(true)
		expect(isStreetSuffixToken("Springfield")).toBe(false)
	})
})
