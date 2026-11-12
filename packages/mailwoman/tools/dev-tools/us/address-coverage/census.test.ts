// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { attributePoints, coverageRatio, readCountyHousing, UNITS_PER_STRUCTURE } from "./census.ts"

const HEADER = ["NAME", "B25024_001E", ...UNITS_PER_STRUCTURE.map(([variable]) => variable), "state", "county"]

describe("readCountyHousing", () => {
	it("keys a county by state and county code and divides each bucket by its units per structure", () => {
		// 100 single-family homes, 4 duplexes (8 units) and one 50-plus building of 200 units.
		const counts = ["100", "0", "8", "0", "0", "0", "0", "200", "0", "0"]
		const housing = readCountyHousing([HEADER, ["Capitol Planning Region, Connecticut", "308", ...counts, "09", "110"]])

		expect(housing.get("09110")).toEqual({
			name: "Capitol Planning Region, Connecticut",
			housingUnits: 308,
			structures: 100 + 8 / 2 + 200 / 100,
		})
	})

	it("refuses a table without a column it needs, and a count that is not a number", () => {
		expect(() => readCountyHousing([["NAME", "state", "county"]])).toThrow(/B25024_001E/)

		expect(() =>
			readCountyHousing([HEADER, ["X", "null", ...UNITS_PER_STRUCTURE.map(() => "0"), "09", "110"]])
		).toThrow(/not a count/)
	})
})

describe("attributePoints", () => {
	it("shares a postcode's points by its street segments per county", () => {
		const { byCounty, unattributed } = attributePoints(new Map([["53011", 100]]), [
			{ postcode: "53011", county: "55117", segments: 3 },
			{ postcode: "53011", county: "55089", segments: 1 },
		])

		expect(byCounty.get("55117")).toBe(75)
		expect(byCounty.get("55089")).toBe(25)
		expect(unattributed).toBe(0)
	})

	it("reports points under a postcode with no segment as unattributed", () => {
		const { byCounty, unattributed } = attributePoints(new Map([["00000", 7]]), [])

		expect(byCounty.size).toBe(0)
		expect(unattributed).toBe(7)
	})
})

describe("coverageRatio", () => {
	it("divides address points by estimated structures, and reads null for a county with none", () => {
		expect(coverageRatio({ structures: 0, addressPoints: 4 })).toBeNull()
		expect(coverageRatio({ structures: 4, addressPoints: 1 })).toBe(0.25)
	})
})
