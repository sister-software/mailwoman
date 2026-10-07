/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests what a coverage fact licenses. A hard country filter is safe only when a fact records that it was measured and
 *   passed. Measured-and-failed and never-measured are separate readings. Neither reading permits the filter.
 */

import { describe, expect, it } from "vitest"

import { hardCountrySafelistFromCoverage, type CountryCoverageFact } from "#resolver"

const FACT = (country: string, hardFilterSafe: boolean): CountryCoverageFact => ({
	country,
	hardFilterSafe,
	hardResolveRate: null,
	sampleSize: null,
	measuredAt: "2026-01-01",
	source: "unit fixture",
})

describe("hardCountrySafelistFromCoverage", () => {
	it("admits only countries whose fact says the filter is safe", () => {
		const safelist = hardCountrySafelistFromCoverage([FACT("US", true), FACT("FI", false)])

		expect(safelist.has("US")).toBe(true)
		// Measured and failed is a first-class record.
		// It cannot make the country safe.
		expect(safelist.has("FI")).toBe(false)
	})

	it("treats an absent country as never measured rather than as safe", () => {
		expect(hardCountrySafelistFromCoverage([FACT("US", true)]).has("DE")).toBe(false)
	})

	it("normalizes the country to upper case, so a lower-case fact still matches a probe", () => {
		expect(hardCountrySafelistFromCoverage([FACT("gb", true)]).has("GB")).toBe(true)
	})
})
