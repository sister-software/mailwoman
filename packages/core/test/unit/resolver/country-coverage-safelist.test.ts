/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins what a coverage fact licenses: a hard country filter is safe only where a fact says it was measured AND
 *   passed. Measured-and-failed and never-measured are separate readings, and neither may read as safe.
 */

import { hardCountrySafelistFromCoverage, type CountryCoverageFact } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

const FACT = (country: string, hardFilterSafe: boolean): CountryCoverageFact => ({
	country,
	hardFilterSafe,
	measuredAt: "2026-01-01",
	source: "unit fixture",
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
