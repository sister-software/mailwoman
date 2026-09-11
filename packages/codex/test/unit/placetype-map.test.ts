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
	isPlacetypeFallback,
	PLACETYPE_FILTER_GROUPS,
	placetypeMapForCountry,
} from "@mailwoman/codex/placetype-map"
import { describe, expect, it } from "vitest"

describe("DEFAULT_PLACETYPE_MAP", () => {
	it("routes the JP tiers the candidate gazetteer keys, and leaves the street tiers to the extracts", () => {
		expect(DEFAULT_PLACETYPE_MAP.prefecture).toBe("region")
		expect(DEFAULT_PLACETYPE_MAP.municipality).toBe("locality")
		expect(DEFAULT_PLACETYPE_MAP.district).toBe("locality")
		expect(DEFAULT_PLACETYPE_MAP.street).toBeUndefined()
		expect(DEFAULT_PLACETYPE_MAP.house_number).toBeUndefined()
	})
})

describe("placetypeMapForCountry", () => {
	it("types the Taiwanese 鄉鎮市區 (`subregion`) as a locality-band placetype, and leaves every other tag alone", () => {
		const tw = placetypeMapForCountry("TW")

		expect(tw.subregion).toBe("locality")
		expect(tw.region).toBe(DEFAULT_PLACETYPE_MAP.region)
		expect(tw.municipality).toBe(DEFAULT_PLACETYPE_MAP.municipality)
		expect(placetypeMapForCountry("tw")).toEqual(tw)
	})

	it("answers the default map ITSELF for a country with no override, so a caller can compare by identity", () => {
		expect(placetypeMapForCountry("KR")).toBe(DEFAULT_PLACETYPE_MAP)
		expect(placetypeMapForCountry("us")).toBe(DEFAULT_PLACETYPE_MAP)
		expect(placetypeMapForCountry(undefined)).toBe(DEFAULT_PLACETYPE_MAP)
		expect(placetypeMapForCountry(null)).toBe(DEFAULT_PLACETYPE_MAP)
		// The Korean 시군구 stay counties: a KR line under the default band reads exactly as before.
		expect(placetypeMapForCountry("KR").subregion).toBe("county")
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
