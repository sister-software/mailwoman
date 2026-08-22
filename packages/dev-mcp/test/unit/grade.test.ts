/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { caseCarriesTruth, gradeRow, seedToCaseTable, significance } from "@mailwoman/dev-mcp/grade"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import type { GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { describe, expect, it } from "vitest"

function seed(partial: Partial<SeedCase> = {}): SeedCase {
	return {
		id: "x-1",
		input: "somewhere",
		source: "test",
		addressKind: "bare_city_global",
		country: "US",
		status: "pass",
		addedAt: "2026-08-16",
		...partial,
	} as SeedCase
}

function result(partial: Partial<GauntletResult> = {}): GauntletResult {
	return {
		components: {},
		lat: null,
		lon: null,
		tier: "none",
		locality: null,
		region: null,
		country: null,
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		postcode_country_scope: null,
		hierarchy: [],
		...partial,
	} as GauntletResult
}

describe("seedToCaseTable", () => {
	it("carries the expectation columns the grader reads", () => {
		const table = seedToCaseTable(seed({ expectComponents: { locality: "Paris" }, expectToleranceM: 500 }))

		expect(table.expect_components).toBe(JSON.stringify({ locality: "Paris" }))
		expect(table.expect_tolerance_m).toBe(500)
	})

	it("maps an absent expectation to null, never to a falsy stand-in", () => {
		const table = seedToCaseTable(seed())

		expect(table.expect_lat).toBeNull()
		expect(table.expect_components).toBeNull()
		expect(table.expect_abstain).toBeNull()
	})
})

describe("caseCarriesTruth", () => {
	it("is false for a row that asserts nothing", () => {
		expect(caseCarriesTruth(seed())).toBe(false)
	})

	it("is true for each kind of expectation on its own", () => {
		expect(caseCarriesTruth(seed({ expectComponents: { locality: "Paris" } }))).toBe(true)
		expect(caseCarriesTruth(seed({ expectLat: 1, expectLon: 2 }))).toBe(true)
		expect(caseCarriesTruth(seed({ expectTier: "admin" }))).toBe(true)
		expect(caseCarriesTruth(seed({ expectAbstain: true }))).toBe(true)
	})

	it("does not count a half-specified coordinate as truth", () => {
		expect(caseCarriesTruth(seed({ expectLat: 1 }))).toBe(false)
	})
})

describe("gradeRow", () => {
	const check = (_c: unknown, r: GauntletResult): string[] => (r.locality === "Paris" ? [] : ["locality wrong"])

	it("grades by issue COUNT, so swapping one wrong value for another is neutral", () => {
		// A text diff would call this a change. The grade is unmoved, and the grade is what a verdict rests on.
		const graded = gradeRow(
			seed({ expectComponents: { locality: "Paris" } }),
			result({ locality: "Lyon" }),
			result({ locality: "Nice" }),
			check
		)

		expect(graded.grade).toBe("neutral")
	})

	it("reports improved and regressed in the right direction", () => {
		const better = gradeRow(
			seed({ expectComponents: { locality: "Paris" } }),
			result({ locality: "Lyon" }),
			result({ locality: "Paris" }),
			check
		)

		const worse = gradeRow(
			seed({ expectComponents: { locality: "Paris" } }),
			result({ locality: "Paris" }),
			result({ locality: "Lyon" }),
			check
		)

		expect(better.grade).toBe("improved")
		expect(worse.grade).toBe("regressed")
	})

	it("marks a row with no expectations ungradeable, never neutral", () => {
		// The distinction the 2026-08-15 failure turned on: an ungradeable row added to the neutral pile inflates the
		// denominator of a verdict it was never part of.
		const graded = gradeRow(seed(), result(), result(), check)

		expect(graded.grade).toBe("ungradeable")
	})
})

describe("significance", () => {
	it("calls a real difference at a large n", () => {
		const test = significance(400, 460, 558)

		expect(test.verdict).toBe("b_better")
		expect(test.p!).toBeLessThan(0.05)
	})

	it("says indistinguishable, never 'no effect', and always states the MDE", () => {
		const test = significance(400, 404, 558)

		expect(test.verdict).toBe("indistinguishable")
		expect(test.sentence).toContain("could not have detected an effect smaller than")
		expect(test.sentence).not.toContain("no effect")
		expect(test.mde_pp_at_this_n).toBeGreaterThan(0)
	})

	it("reports a bigger MDE at a smaller n — the whole reason it is printed", () => {
		expect(significance(5, 5, 10).mde_pp_at_this_n!).toBeGreaterThan(significance(400, 400, 558).mde_pp_at_this_n!)
	})

	it("distinguishes an untestable run from a tie", () => {
		const test = significance(0, 0, 0)

		expect(test.verdict).toBe("untestable")
		expect(test.sentence).toContain("This is not a tie")
	})

	it("handles identical arms without dividing by zero", () => {
		const test = significance(558, 558, 558)

		expect(test.verdict).toBe("indistinguishable")
		expect(test.mde_pp_at_this_n).toBeGreaterThan(0)
	})
})
