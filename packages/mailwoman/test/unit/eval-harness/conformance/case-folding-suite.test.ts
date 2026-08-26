/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The committed case-folding suite, checked against the corpus it was drawn from. No model, no gazetteer —
 *   two JSONL files and the pure law module, so this runs wherever the repo does.
 *
 *   THE POINT IS THAT NOTHING HERE IS AUTHORED. Every `base` must be the verbatim `input` of the committed
 *   board row its `rowRef` names, and every `variant` must be exactly the named transformation applied to that
 *   base. A hand-typed variant is how a case-folding row quietly acquires a dropped accent or a collapsed
 *   space, and the law then reports on a transformation nobody declared — so the suite is re-derived here
 *   rather than trusted.
 *
 *   The base rows are additionally required to be `status: pass` on the board. A case-folding violation
 *   stated over a row the pipeline already fails says nothing about casing.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import {
	auditCaseFoldingSuite,
	CASE_FOLDING_LAW,
	CASE_FOLDING_SUITE_PATH,
	CASE_TRANSFORMATION_BY_NAME,
	CASE_TRANSFORMATIONS,
	caseApplicability,
	classifyCaseTransformation,
} from "mailwoman/eval-harness/conformance/case-folding"
import { type ConformanceFixture, loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import { CASES_DIR, loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import { beforeAll, describe, expect, it } from "vitest"

let fixtures: ConformanceFixture[]
let corpus: Map<string, SeedCase>

beforeAll(async () => {
	fixtures = await loadConformanceFixtures(CASE_FOLDING_SUITE_PATH)
	corpus = new Map((await loadRegressionCases()).map((seedCase) => [seedCase.id, seedCase]))
})

/**
 * Split `cases/gb/regression.jsonl#gb-downing-us-scoped` into the file it names and the case id inside it.
 */
function splitRowRef(rowRef: string): { file: string; caseID: string } {
	const [file, caseID] = rowRef.split("#")

	return { file: file ?? "", caseID: caseID ?? "" }
}

describe("the committed case-folding suite", () => {
	it("loads through the shared conformance loader", () => {
		expect(fixtures.length).toBeGreaterThan(0)
		expect(new Set(fixtures.map((fixture) => fixture.law))).toEqual(new Set([CASE_FOLDING_LAW]))
	})

	it("passes its own audit", () => {
		expect(auditCaseFoldingSuite(fixtures)).toEqual([])
	})

	it("draws every base from a committed board row, verbatim", () => {
		for (const fixture of fixtures) {
			const { file, caseID } = splitRowRef(fixture.rowRef!)
			const seedCase = corpus.get(caseID)

			expect(seedCase, `${fixture.id}: rowRef names no committed case (${fixture.rowRef})`).toBeDefined()
			expect(fixture.base, `${fixture.id}: base is not the committed input`).toBe(seedCase!.input)

			expect(
				existsSync(join(CASES_DIR, file.replace(/^cases\//, ""))),
				`${fixture.id}: rowRef names no file (${file})`
			).toBe(true)
		}
	})

	it("states every variant as a named transformation of its base", () => {
		for (const fixture of fixtures) {
			const transformation = classifyCaseTransformation(fixture.base, fixture.variant)

			expect(transformation, `${fixture.id}: variant is not a named case transformation`).not.toBeNull()
			expect(CASE_TRANSFORMATION_BY_NAME[transformation!](fixture.base)).toBe(fixture.variant)
		}
	})

	it("keeps every row's context in step with the committed row it was drawn from", () => {
		for (const fixture of fixtures) {
			const seedCase = corpus.get(splitRowRef(fixture.rowRef!).caseID)!

			expect(fixture.context?.caseCountry, `${fixture.id}: caseCountry`).toBe(seedCase.country)
			expect(fixture.context?.defaultCountry, `${fixture.id}: defaultCountry`).toBe(seedCase.defaultCountry)
		}
	})

	it("builds only on board rows the pipeline already passes", () => {
		for (const fixture of fixtures) {
			const seedCase = corpus.get(splitRowRef(fixture.rowRef!).caseID)!

			expect(seedCase.status, `${fixture.id}: ${seedCase.id} is ${seedCase.status} on the board`).toBe("pass")
		}
	})

	it("exercises upper, lower and mixed on at least one committed row", () => {
		const byRow = new Map<string, Set<string>>()

		for (const fixture of fixtures) {
			const transformation = classifyCaseTransformation(fixture.base, fixture.variant)!
			const key = splitRowRef(fixture.rowRef!).caseID

			byRow.set(key, (byRow.get(key) ?? new Set()).add(transformation))
		}

		const complete = [...byRow].filter(([, seen]) => seen.size === CASE_TRANSFORMATIONS.length)

		expect(complete.length, "no committed row carries all three transformations").toBeGreaterThan(0)
	})

	it("omits a transformation only where an applicability rule excludes it", () => {
		const bases = new Map(fixtures.map((fixture) => [splitRowRef(fixture.rowRef!).caseID, fixture]))

		for (const [caseID, sample] of bases) {
			const present = new Set(
				fixtures
					.filter((fixture) => splitRowRef(fixture.rowRef!).caseID === caseID)
					.map((fixture) => classifyCaseTransformation(fixture.base, fixture.variant))
			)

			for (const transformation of CASE_TRANSFORMATIONS) {
				if (present.has(transformation)) continue

				const reading = caseApplicability(sample.base, transformation, sample.context?.caseCountry)

				expect(reading.applicable, `${caseID}: ${transformation} is absent but applicable — ${reading.reason}`).toBe(
					false
				)
			}
		}
	})

	it("measures more than one comparator and more than one country", () => {
		expect(new Set(fixtures.map((fixture) => fixture.outcomeComparator)).size).toBeGreaterThan(1)
		expect(new Set(fixtures.map((fixture) => fixture.context?.caseCountry)).size).toBeGreaterThan(1)
	})

	it("gives every tracked row a reference and a note, and every gating row neither", () => {
		for (const fixture of fixtures) {
			if ((fixture.status ?? "pass") === "pass") {
				expect(fixture.bugRef, `${fixture.id}: a gating row must not name a defect`).toBeUndefined()

				continue
			}

			expect(fixture.bugRef, `${fixture.id}: tracked without a reference`).toBeTruthy()
			expect(fixture.note, `${fixture.id}: tracked without a note`).toBeTruthy()
		}
	})

	it("keeps its ids stable and derived from the row and the transformation", () => {
		for (const fixture of fixtures) {
			const { caseID } = splitRowRef(fixture.rowRef!)
			const transformation = classifyCaseTransformation(fixture.base, fixture.variant)!

			expect(fixture.id).toBe(`cf-${caseID}-${transformation}`)
		}
	})
})
