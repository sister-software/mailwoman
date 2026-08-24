/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `CapitalIndex` — the country + coordinate probe behind the capital-status ranking axis (#1880). The contract
 *   under test: matching is identity by proximity WITHIN the row's own country, never by name, and a missing
 *   coordinate or unknown country reads as `none`, never as a throw.
 */

import {
	CAPITAL_LEVEL,
	CAPITAL_MATCH_RADIUS_KM,
	CapitalIndex,
	capitalPreferenceLog10,
} from "@mailwoman/resolver-wof-sqlite/capitals"
import { describe, expect, it } from "vitest"

// San José CR (the national capital) and Springfield IL (an admin-1 seat) — real coordinates so the
// radius sentences below mean what they say.
const index = new CapitalIndex([
	{ country: "CR", latitude: 9.9333, longitude: -84.0833, level: "national" },
	{ country: "US", latitude: 39.8017, longitude: -89.6437, level: "admin1" },
])

describe("CapitalIndex.levelAt", () => {
	it("matches a candidate near the reference point, in that country only", () => {
		// A WOF centroid a few km off the GeoNames point still reads as the capital…
		expect(index.levelAt("CR", 9.95, -84.1)).toBe(CAPITAL_LEVEL.national)
		// …but the same coordinates under another country code never do.
		expect(index.levelAt("PA", 9.95, -84.1)).toBe(CAPITAL_LEVEL.none)
	})

	it("does not match a same-country namesake beyond the radius", () => {
		// San José de Alajuela-distance: ~200 km up-country is another place, whatever it is named.
		expect(index.levelAt("CR", 11, -85.5)).toBe(CAPITAL_LEVEL.none)
	})

	it("answers none — never throws — for a missing coordinate or unknown country", () => {
		expect(index.levelAt("CR", null, -84.1)).toBe(CAPITAL_LEVEL.none)
		expect(index.levelAt("CR", 9.95, undefined)).toBe(CAPITAL_LEVEL.none)
		expect(index.levelAt(undefined, 9.95, -84.1)).toBe(CAPITAL_LEVEL.none)
		expect(index.levelAt("ZZ", 9.95, -84.1)).toBe(CAPITAL_LEVEL.none)
	})

	it("is case-insensitive on the country code", () => {
		expect(index.levelAt("cr", 9.9333, -84.0833)).toBe(CAPITAL_LEVEL.national)
	})

	it("prefers the national level when both a capital and a seat sit within the radius", () => {
		const both = new CapitalIndex([
			{ country: "MX", latitude: 19.4285, longitude: -99.1277, level: "admin1" },
			{ country: "MX", latitude: 19.4285, longitude: -99.1277, level: "national" },
		])

		expect(both.levelAt("MX", 19.43, -99.13)).toBe(CAPITAL_LEVEL.national)
	})
})

describe("capitalPreferenceLog10", () => {
	it("maps national > admin1 > none, in log10-population units", () => {
		expect(capitalPreferenceLog10(CAPITAL_LEVEL.national)).toBe(2)
		expect(capitalPreferenceLog10(CAPITAL_LEVEL.admin1)).toBe(1)
		expect(capitalPreferenceLog10(CAPITAL_LEVEL.none)).toBe(0)
	})
})

describe("CAPITAL_MATCH_RADIUS_KM", () => {
	it("holds the metro-scale bound the levelAt sentences above rely on", () => {
		expect(CAPITAL_MATCH_RADIUS_KM).toBe(25)
	})
})
