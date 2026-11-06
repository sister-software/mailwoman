// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { attributePoints, coverageRatio, readCountyHousingUnits } from "./census.ts"

describe("readCountyHousingUnits", () => {
	it("reads the housing units of a county by its GEOID", () => {
		const table =
			"USPS\tGEOID\tNAME\tPOP10\tHU10\tINTPTLONG                  \nWI\t55117\tSheboygan County\t115507\t49617\t-87.9\n"

		expect(readCountyHousingUnits(table).get("55117")).toBe(49_617)
	})

	it("refuses a table without a column it needs", () => {
		expect(() => readCountyHousingUnits("USPS\tGEOID\nWI\t55117\n")).toThrow(/HU10/)
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
	it("reads null for a county with no housing units", () => {
		expect(coverageRatio({ housingUnits: 0, addressPoints: 4 })).toBeNull()
		expect(coverageRatio({ housingUnits: 4, addressPoints: 1 })).toBe(0.25)
	})
})
