/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The S42 template inventory's internal consistency.
 *
 *   The 72 codes were confirmed against UPU's own 72-option template selector on 2026-09-30, and the 2010 group
 *   of seventeen is quoted from UPU's own announcement. Both documents are retained under
 *   `internal/strategy/rights-receipts/upu-s42-2026-09-30/`. These assertions hold the counts, the code
 *   resolution and the cohort containment. That is what a reader can check without re-fetching.
 */

import { describe, expect, it } from "vitest"

import {
	S42Cohort,
	s42CohortForJurisdiction,
	S42_COHORT_2006,
	S42_COHORT_2010_ADDITIONS,
	S42_TEMPLATE_JURISDICTIONS,
} from "#address/s42-templates"
import { ISO2_TO_NAME } from "#country"

describe("the S42 template inventory", () => {
	it("holds 72 distinct jurisdictions", () => {
		expect(S42_TEMPLATE_JURISDICTIONS).toHaveLength(72)
		expect(new Set(S42_TEMPLATE_JURISDICTIONS).size).toBe(72)
	})

	it("holds the 2006 group of eleven and the 2010 group of seventeen", () => {
		expect(S42_COHORT_2006).toHaveLength(11)
		expect(S42_COHORT_2006.length + S42_COHORT_2010_ADDITIONS.length).toBe(17)
		expect(new Set([...S42_COHORT_2006, ...S42_COHORT_2010_ADDITIONS]).size).toBe(17)
	})

	it("keeps every cohort member in the current inventory", () => {
		const current = new Set(S42_TEMPLATE_JURISDICTIONS)

		for (const code of [...S42_COHORT_2006, ...S42_COHORT_2010_ADDITIONS]) {
			expect(current.has(code), code).toBe(true)
		}
	})

	it("gives every code a country this repository can name", () => {
		// A typo in a supplied list reads as a template for a country that does not exist.
		for (const code of S42_TEMPLATE_JURISDICTIONS) {
			expect(ISO2_TO_NAME.get(code), code).toBeDefined()
		}
	})

	it("sorts each code into one cohort, earliest first", () => {
		expect(s42CohortForJurisdiction("GB")).toBe(S42Cohort.Original2006)
		expect(s42CohortForJurisdiction("US")).toBe(S42Cohort.Original2006)
		expect(s42CohortForJurisdiction("DE")).toBe(S42Cohort.Added2010)
		expect(s42CohortForJurisdiction("ZA")).toBe(S42Cohort.Added2010)
		expect(s42CohortForJurisdiction("CN")).toBe(S42Cohort.Current)
	})

	it("answers `null` for a jurisdiction the inventory omits, which states that no crosswalk exists", () => {
		// Japan runs a national addressing system and has no S42 template in this inventory,
		// so the two facts have to stay separable.
		expect(s42CohortForJurisdiction("JP")).toBeNull()
		expect(s42CohortForJurisdiction("SE")).toBeNull()
		expect(s42CohortForJurisdiction("")).toBeNull()
		expect(s42CohortForJurisdiction(null)).toBeNull()
	})

	it("reads a code in any case, with surrounding space", () => {
		expect(s42CohortForJurisdiction(" gb ")).toBe(S42Cohort.Original2006)
	})
})
