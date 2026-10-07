/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for `CapitalIndex`, the three-conjunct identity probe behind the capital promotion: same
 *   country, within the radius and the candidate's own folded name in the entry's name set.
 */

import { describe, expect, it } from "vitest"

import { CAPITAL_LEVEL, CAPITAL_MATCH_RADIUS_KM, CapitalIndex } from "#capitals"

// San José CR (the national capital, with its GeoNames alternates) and Salt Lake City
// (an admin-1 seat), real coordinates so the radius checks below mean what they say.
const index = new CapitalIndex([
	{ country: "CR", latitude: 9.9333, longitude: -84.0833, level: "national", k: ["san jose", "chepe"] },
	{ country: "US", latitude: 40.7608, longitude: -111.891, level: "admin1", k: ["salt lake city", "slc"] },
])

describe("CapitalIndex.levelOfPlace", () => {
	it("matches on country + proximity + name membership together", () => {
		expect(index.levelOfPlace("San José", "CR", 9.95, -84.1)).toBe(CAPITAL_LEVEL.national)
		expect(index.levelOfPlace("Chepe", "CR", 9.95, -84.1)).toBe(CAPITAL_LEVEL.national)
		expect(index.levelOfPlace("San José", "PA", 9.95, -84.1)).toBe(CAPITAL_LEVEL.none)
	})

	it("refuses a same-name namesake beyond the radius", () => {
		expect(index.levelOfPlace("San José", "CR", 11, -85.5)).toBe(CAPITAL_LEVEL.none)
	})

	it("refuses a capital-ADJACENT namesake inside the radius — the iteration-1 false-positive class", () => {
		// North Salt Lake's name is not in Salt Lake City's name set, so the name conjunct excludes it.
		expect(index.levelOfPlace("North Salt Lake", "US", 40.8477, -111.9227)).toBe(CAPITAL_LEVEL.none)
		expect(index.levelOfPlace("Salt Lake City", "US", 40.7608, -111.891)).toBe(CAPITAL_LEVEL.admin1)
	})

	it("answers none — never throws — for a missing name, coordinate, or unknown country", () => {
		expect(index.levelOfPlace(null, "CR", 9.95, -84.1)).toBe(CAPITAL_LEVEL.none)
		expect(index.levelOfPlace("San José", "CR", null, -84.1)).toBe(CAPITAL_LEVEL.none)
		expect(index.levelOfPlace("San José", null, 9.95, -84.1)).toBe(CAPITAL_LEVEL.none)
		expect(index.levelOfPlace("San José", "ZZ", 9.95, -84.1)).toBe(CAPITAL_LEVEL.none)
	})

	it("is case-insensitive on the country code and folds the name", () => {
		expect(index.levelOfPlace("SAN JOSE", "cr", 9.9333, -84.0833)).toBe(CAPITAL_LEVEL.national)
	})

	it("prefers the national level when both a capital and a seat match", () => {
		const both = new CapitalIndex([
			{ country: "MX", latitude: 19.4285, longitude: -99.1277, level: "admin1", k: ["mexico city"] },
			{ country: "MX", latitude: 19.4285, longitude: -99.1277, level: "national", k: ["mexico city"] },
		])

		expect(both.levelOfPlace("Mexico City", "MX", 19.43, -99.13)).toBe(CAPITAL_LEVEL.national)
	})
})

describe("CAPITAL_MATCH_RADIUS_KM", () => {
	it("holds the centroid-drift bound the sentences above rely on", () => {
		expect(CAPITAL_MATCH_RADIUS_KM).toBe(25)
	})
})
