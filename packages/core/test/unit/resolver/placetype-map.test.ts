/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins the two rules a placetype filter rests on: which rows a request reaches, and whether reaching one counts as
 *   an exact answer or a widened one. Both are consulted per candidate on the resolver's hot path, and neither had
 *   direct coverage — `expandPlacetypeFilter` was exercised only incidentally through a resolver walk.
 */

import {
	DEFAULT_PLACETYPE_MAP,
	expandPlacetypeFilter,
	hardCountrySafelistFromCoverage,
	isPlacetypeFallback,
	PLACETYPE_FILTER_GROUPS,
	type CountryCoverageFact,
} from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

const FACT = (country: string, hardFilterSafe: boolean): CountryCoverageFact => ({
	country,
	hardFilterSafe,
	measuredAt: "2026-01-01",
	source: "unit fixture",
})

describe("DEFAULT_PLACETYPE_MAP", () => {
	it("routes the JP tiers the candidate gazetteer keys, and leaves the street tiers to the extracts", () => {
		expect(DEFAULT_PLACETYPE_MAP.prefecture).toBe("region")
		expect(DEFAULT_PLACETYPE_MAP.municipality).toBe("locality")
		expect(DEFAULT_PLACETYPE_MAP.district).toBe("locality")
		expect(DEFAULT_PLACETYPE_MAP.street).toBeUndefined()
		expect(DEFAULT_PLACETYPE_MAP.house_number).toBeUndefined()
	})
})

describe("expandPlacetypeFilter", () => {
	it("passes null through, so an unfiltered query stays unfiltered", () => {
		expect(expandPlacetypeFilter(null)).toBeNull()
	})

	it("returns an empty list unchanged", () => {
		expect(expandPlacetypeFilter([])).toEqual([])
	})

	it("expands a locality request to its equivalence group", () => {
		const expanded = expandPlacetypeFilter(["locality"])

		expect(expanded).toEqual(PLACETYPE_FILTER_GROUPS.locality)
		// Brooklyn is a borough; a strict locality filter made it unreachable.
		expect(expanded).toContain("borough")
	})

	it("keeps a placetype that has no group", () => {
		expect(expandPlacetypeFilter(["country"])).toContain("country")
	})

	it("does not duplicate a placetype reachable through two requests", () => {
		const expanded = expandPlacetypeFilter(["locality", "localadmin"])

		expect(new Set(expanded).size).toBe(expanded.length)
	})
})

describe("isPlacetypeFallback", () => {
	it("is false when the candidate is exactly what was requested", () => {
		expect(isPlacetypeFallback("locality", "locality")).toBe(false)
	})

	it("is false for a placetype with no equivalence group", () => {
		expect(isPlacetypeFallback("country", "country")).toBe(false)
	})

	it("is true only for a MACRO widening inside the request's own group", () => {
		expect(isPlacetypeFallback("region", "macroregion")).toBe(true)
		// A same-group sibling that is not a macro level is a match, not a widening.
		expect(isPlacetypeFallback("locality", "borough")).toBe(false)
	})

	it("is false for a macro placetype outside the request's group", () => {
		expect(isPlacetypeFallback("locality", "macroregion")).toBe(false)
	})
})

describe("hardCountrySafelistFromCoverage", () => {
	it("admits only countries whose fact says the filter is safe", () => {
		const safelist = hardCountrySafelistFromCoverage([FACT("US", true), FACT("FI", false)])

		expect(safelist.has("US")).toBe(true)
		// Measured and FAILED is a first-class record, and it must not read as safe.
		expect(safelist.has("FI")).toBe(false)
	})

	it("treats an absent country as never measured rather than as safe", () => {
		expect(hardCountrySafelistFromCoverage([FACT("US", true)]).has("DE")).toBe(false)
	})

	it("normalizes the country to upper case, so a lower-case fact still matches a probe", () => {
		expect(hardCountrySafelistFromCoverage([FACT("gb", true)]).has("GB")).toBe(true)
	})
})

describe("DEFAULT_PLACETYPE_MAP", () => {
	it("omits the tags whose rows live outside the admin gazetteer", () => {
		// Components absent from the map are NOT queried; their classifier attribution stands.
		expect(DEFAULT_PLACETYPE_MAP.street).toBeUndefined()
		expect(DEFAULT_PLACETYPE_MAP.house_number).toBeUndefined()
	})

	it("routes postcode to WOF's own placetype name", () => {
		// The tags and the taxonomy disagree on the spelling; the map is where that is reconciled.
		expect(DEFAULT_PLACETYPE_MAP.postcode).toBe("postalcode")
	})
})
