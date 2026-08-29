/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The committed punctuation suite, checked against the corpus it was drawn from. No model, no gazetteer —
 *   two JSONL files and the pure law module, so this runs wherever the repo does.
 *
 *   THE POINT IS THAT NOTHING HERE IS AUTHORED. Every `base` must be the verbatim `input` of the committed
 *   board row its `rowRef` names, and every `variant` must be exactly the named transformation applied to
 *   that base. A hand-typed variant is how a "punctuation" row quietly acquires a dropped accent, and the law
 *   then reports on a transformation nobody declared — so the suite is re-derived here rather than trusted.
 *
 *   AND THAT NO ARM IS MISSING BY ACCIDENT. The cross product of the committed bases and five transformations
 *   is what the law claims to state; every absent arm has to name the applicability rule that refuses it, and
 *   all three declared rules have to refuse at least one real arm. A suite that could quietly drop the arms it
 *   fails would report a smaller violation count, and a smaller count is indistinguishable from a law that
 *   holds.
 *
 *   THIS LEG SUPPLIES THE HALF THE AUDIT CANNOT. `punctuationApplicability` refuses a removal whose mark the
 *   row's own comparator would read back out of a component value; deciding that needs the row's ASSERTED
 *   spans, which live in the corpus rather than in the fixture. The audit applies the declared half, and the
 *   reading here applies both.
 *
 *   The base rows are additionally required to be `status: pass` on the board. A punctuation violation stated
 *   over a row the pipeline already fails says nothing about punctuation.
 */

import { existsSync } from "@mailwoman/platform/fs"
import { join } from "@mailwoman/platform/path"
import { type ConformanceFixture, loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditPunctuationSuite,
	classifyPunctuationTransformation,
	PUNCTUATION_APPLICABILITY_RULES,
	PUNCTUATION_LAW,
	PUNCTUATION_SUITE_PATH,
	PUNCTUATION_TRANSFORMATION_BY_NAME,
	PUNCTUATION_TRANSFORMATION_SCOPE,
	PUNCTUATION_TRANSFORMATIONS,
	punctuationApplicability,
} from "mailwoman/eval-harness/conformance/punctuation"
import { CASES_DIR, loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import { beforeAll, describe, expect, it } from "vitest"

let fixtures: ConformanceFixture[]
let corpus: Map<string, SeedCase>

beforeAll(async () => {
	fixtures = await loadConformanceFixtures(PUNCTUATION_SUITE_PATH)
	corpus = new Map((await loadRegressionCases()).map((seedCase) => [seedCase.id, seedCase]))
})

/**
 * Split `cases/gb/regression.jsonl#gb-interesting-lloyds` into the file it names and the case id inside it.
 */
function splitRowRef(rowRef: string): { file: string; caseID: string } {
	const [file, caseID] = rowRef.split("#")

	return { file: file ?? "", caseID: caseID ?? "" }
}

/**
 * The component values a committed row asserts — what a text-reading comparator would grade, and therefore what decides
 * whether a removal arm could be reported by the echo of its own mark.
 */
function assertedSpans(seedCase: SeedCase): string[] {
	return Object.values(seedCase.expectComponents ?? {}).filter((value) => typeof value === "string")
}

describe("the committed punctuation suite", () => {
	it("loads through the shared conformance loader", () => {
		expect(fixtures.length).toBeGreaterThan(0)
		expect(new Set(fixtures.map((fixture) => fixture.law))).toEqual(new Set([PUNCTUATION_LAW]))
	})

	it("passes its own audit", () => {
		expect(auditPunctuationSuite(fixtures)).toEqual([])
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
			const transformation = classifyPunctuationTransformation(fixture.base, fixture.variant)

			expect(transformation, `${fixture.id}: variant is not a named punctuation transformation`).not.toBeNull()
			expect(PUNCTUATION_TRANSFORMATION_BY_NAME[transformation!](fixture.base)).toBe(fixture.variant)
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

	it("exercises every one of the five transformations", () => {
		const seen = new Set(fixtures.map((fixture) => classifyPunctuationTransformation(fixture.base, fixture.variant)))

		for (const transformation of PUNCTUATION_TRANSFORMATIONS) {
			expect(seen.has(transformation), `no committed row states ${transformation}`).toBe(true)
		}
	})

	it("carries both removals on one committed row, where neither can be reported by its own echo", () => {
		const removals = PUNCTUATION_TRANSFORMATIONS.filter(
			(transformation) => PUNCTUATION_TRANSFORMATION_SCOPE[transformation] === "removal"
		)

		const byRow = new Map<string, Set<string>>()

		for (const fixture of fixtures) {
			const transformation = classifyPunctuationTransformation(fixture.base, fixture.variant)!
			const key = splitRowRef(fixture.rowRef!).caseID

			byRow.set(key, (byRow.get(key) ?? new Set()).add(transformation))
		}

		const complete = [...byRow].filter(([, seen]) => removals.every((transformation) => seen.has(transformation)))

		expect(complete.length, "no committed row states both removal transformations").toBeGreaterThan(0)
	})

	it("omits a transformation only where an applicability rule excludes it", () => {
		const bases = new Map(fixtures.map((fixture) => [splitRowRef(fixture.rowRef!).caseID, fixture]))

		for (const [caseID, sample] of bases) {
			const present = new Set(
				fixtures
					.filter((fixture) => splitRowRef(fixture.rowRef!).caseID === caseID)
					.map((fixture) => classifyPunctuationTransformation(fixture.base, fixture.variant))
			)

			for (const transformation of PUNCTUATION_TRANSFORMATIONS) {
				if (present.has(transformation)) continue

				const reading = punctuationApplicability(sample.base, transformation, {
					comparator: sample.outcomeComparator,
					echoedSpans: assertedSpans(corpus.get(caseID)!),
				})

				expect(reading.applicable, `${caseID}: ${transformation} is absent but applicable — ${reading.reason}`).toBe(
					false
				)
			}
		}
	})

	it("gives all three declared rules something real to refuse", () => {
		const fired = new Set<string>()

		for (const fixture of fixtures) {
			const caseID = splitRowRef(fixture.rowRef!).caseID

			for (const transformation of PUNCTUATION_TRANSFORMATIONS) {
				const reading = punctuationApplicability(fixture.base, transformation, {
					comparator: fixture.outcomeComparator,
					echoedSpans: assertedSpans(corpus.get(caseID)!),
				})

				if (reading.rule) {
					fired.add(reading.rule)
				}
			}
		}

		for (const rule of PUNCTUATION_APPLICABILITY_RULES) {
			expect(fired.has(rule), `no committed base exercises ${rule} — a rule nothing refuses is inert`).toBe(true)
		}
	})

	it("measures more than one comparator and more than one country", () => {
		expect(new Set(fixtures.map((fixture) => fixture.outcomeComparator)).size).toBeGreaterThan(1)
		expect(new Set(fixtures.map((fixture) => fixture.context?.caseCountry)).size).toBeGreaterThan(1)
	})

	it("gives every tracked row a reference and a note, and every blocking row no reference", () => {
		for (const fixture of fixtures) {
			if ((fixture.status ?? "pass") === "pass") {
				expect(fixture.bugRef, `${fixture.id}: a blocking row must not name a defect`).toBeUndefined()

				continue
			}

			expect(fixture.bugRef, `${fixture.id}: tracked without a reference`).toBeTruthy()
			expect(fixture.note, `${fixture.id}: tracked without a note`).toBeTruthy()
		}
	})

	it("keeps its ids stable and derived from the row and the transformation", () => {
		for (const fixture of fixtures) {
			const { caseID } = splitRowRef(fixture.rowRef!)
			const transformation = classifyPunctuationTransformation(fixture.base, fixture.variant)!

			expect(fixture.id).toBe(`pn-${caseID}-${transformation}`)
		}
	})
})
