// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The county designator split the NAD adapter and the US county recipe share.
 */

import { describe, expect, it } from "vitest"

import { namesUSCounty, splitUSCountyDesignator } from "#us/county"

describe("splitUSCountyDesignator", () => {
	it("takes the longest designator, so an Alaska city and borough keeps both words", () => {
		expect(splitUSCountyDesignator("Juneau City and Borough")).toEqual({
			name: "Juneau",
			designator: "City and Borough",
		})

		expect(splitUSCountyDesignator("Bethel Census Area")).toEqual({ name: "Bethel", designator: "Census Area" })
		expect(splitUSCountyDesignator("St. Charles Parish")).toEqual({ name: "St. Charles", designator: "Parish" })
	})

	it("reads an upper-case designator as the table spelling", () => {
		expect(splitUSCountyDesignator("DENTON COUNTY")).toEqual({ name: "DENTON", designator: "County" })
	})

	it("refuses a bare name and an independent city's prefix form", () => {
		expect(splitUSCountyDesignator("Denton")).toBeNull()
		expect(splitUSCountyDesignator("City of Richmond")).toBeNull()
		expect(splitUSCountyDesignator("County")).toBeNull()
	})
})

describe("namesUSCounty", () => {
	it("matches NAD's place column against its bare county column", () => {
		expect(namesUSCounty("Polk County", "Polk")).toBe(true)
		expect(namesUSCounty("DENTON COUNTY", "Denton")).toBe(true)
		expect(namesUSCounty("Bristol Bay Borough", "Bristol Bay Borough")).toBe(true)
	})

	it("leaves a city named for its county, a borough municipality and another county's name alone", () => {
		expect(namesUSCounty("Denton", "Denton")).toBe(false)
		expect(namesUSCounty("CALIFORNIA BOROUGH", "Washington")).toBe(false)
		expect(namesUSCounty("North Penobscot County", "Penobscot")).toBe(false)
		expect(namesUSCounty("WISE COUNTY", "Denton")).toBe(false)
	})
})
