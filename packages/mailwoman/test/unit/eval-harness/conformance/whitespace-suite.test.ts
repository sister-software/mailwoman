/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The committed whitespace suite, checked against the corpus it was drawn from. No model, no gazetteer —
 *   two JSONL files and the pure law module, so this runs wherever the repo does.
 *
 *   THE POINT IS THAT NOTHING HERE IS AUTHORED. Every `base` must be the verbatim `input` of the committed
 *   board row its `rowRef` names, and every `variant` must be exactly the named transformation applied to
 *   that base. A hand-typed variant is how a "whitespace" row quietly acquires a dropped comma, and the law
 *   then reports on a transformation nobody declared — so the suite is re-derived here rather than trusted.
 *
 *   AND THAT NO ARM IS MISSING BY ACCIDENT. The cross product of thirteen board rows and six transformations
 *   is what the law claims to state; every absent arm has to name the applicability rule that refuses it, and
 *   both declared rules have to refuse at least one real arm. A suite that could quietly drop the arms it
 *   fails would report a smaller violation count, and a smaller count is indistinguishable from a law that
 *   holds.
 *
 *   The base rows are additionally required to be `status: pass` on the board. A whitespace violation stated
 *   over a row the pipeline already fails says nothing about spacing.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { type ConformanceFixture, loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditWhitespaceSuite,
	classifyWhitespaceTransformation,
	WHITESPACE_APPLICABILITY_RULES,
	WHITESPACE_LAW,
	WHITESPACE_SUITE_PATH,
	WHITESPACE_TRANSFORMATION_BY_NAME,
	WHITESPACE_TRANSFORMATIONS,
	whitespaceApplicability,
} from "mailwoman/eval-harness/conformance/whitespace"
import { CASES_DIR, loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import { join } from "path-ts"
import { beforeAll, describe, expect, it } from "vitest"

let fixtures: ConformanceFixture[]
let corpus: Map<string, SeedCase>

beforeAll(async () => {
	fixtures = await loadConformanceFixtures(WHITESPACE_SUITE_PATH)
	corpus = new Map((await loadRegressionCases()).map((seedCase) => [seedCase.id, seedCase]))
})

/**
 * Split `cases/gb/regression.jsonl#gb-downing-us-scoped` into the file it names and the case id inside it.
 */
function splitRowRef(rowRef: string): { file: string; caseID: string } {
	const [file, caseID] = rowRef.split("#")

	return { file: file ?? "", caseID: caseID ?? "" }
}

describe("the committed whitespace suite", () => {
	it("loads through the shared conformance loader", () => {
		expect(fixtures.length).toBeGreaterThan(0)
		expect(new Set(fixtures.map((fixture) => fixture.law))).toEqual(new Set([WHITESPACE_LAW]))
	})

	it("passes its own audit", () => {
		expect(auditWhitespaceSuite(fixtures)).toEqual([])
	})

	it("draws every base from a committed board row, verbatim", async () => {
		for (const fixture of fixtures) {
			const { file, caseID } = splitRowRef(fixture.rowRef!)
			const seedCase = corpus.get(caseID)

			expect(seedCase, `${fixture.id}: rowRef names no committed case (${fixture.rowRef})`).toBeDefined()
			expect(fixture.base, `${fixture.id}: base is not the committed input`).toBe(seedCase!.input)

			expect(
				await pathExists(join(CASES_DIR, file.replace(/^cases\//, ""))),
				`${fixture.id}: rowRef names no file (${file})`
			).toBe(true)
		}
	})

	it("states every variant as a named transformation of its base", () => {
		for (const fixture of fixtures) {
			const transformation = classifyWhitespaceTransformation(fixture.base, fixture.variant)

			expect(transformation, `${fixture.id}: variant is not a named whitespace transformation`).not.toBeNull()
			expect(WHITESPACE_TRANSFORMATION_BY_NAME[transformation!](fixture.base)).toBe(fixture.variant)
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

	it("exercises every one of the six transformations", () => {
		const seen = new Set(fixtures.map((fixture) => classifyWhitespaceTransformation(fixture.base, fixture.variant)))

		for (const transformation of WHITESPACE_TRANSFORMATIONS) {
			expect(seen.has(transformation), `no committed row states ${transformation}`).toBe(true)
		}
	})

	it("carries all six on at least one committed row", () => {
		const byRow = new Map<string, Set<string>>()

		for (const fixture of fixtures) {
			const transformation = classifyWhitespaceTransformation(fixture.base, fixture.variant)!
			const key = splitRowRef(fixture.rowRef!).caseID

			byRow.set(key, (byRow.get(key) ?? new Set()).add(transformation))
		}

		const complete = [...byRow].filter(([, seen]) => seen.size === WHITESPACE_TRANSFORMATIONS.length)

		expect(complete.length, "no committed row carries all six transformations").toBeGreaterThan(0)
	})

	it("omits a transformation only where an applicability rule excludes it", () => {
		const bases = new Map(fixtures.map((fixture) => [splitRowRef(fixture.rowRef!).caseID, fixture]))

		for (const [caseID, sample] of bases) {
			const present = new Set(
				fixtures
					.filter((fixture) => splitRowRef(fixture.rowRef!).caseID === caseID)
					.map((fixture) => classifyWhitespaceTransformation(fixture.base, fixture.variant))
			)

			for (const transformation of WHITESPACE_TRANSFORMATIONS) {
				if (present.has(transformation)) continue

				const reading = whitespaceApplicability(sample.base, transformation)

				expect(reading.applicable, `${caseID}: ${transformation} is absent but applicable — ${reading.reason}`).toBe(
					false
				)
			}
		}
	})

	it("gives both declared rules something real to refuse", () => {
		const bases = new Map(fixtures.map((fixture) => [splitRowRef(fixture.rowRef!).caseID, fixture.base]))
		const fired = new Set<string>()

		for (const base of bases.values()) {
			for (const transformation of WHITESPACE_TRANSFORMATIONS) {
				const reading = whitespaceApplicability(base, transformation)

				if (reading.rule) {
					fired.add(reading.rule)
				}
			}
		}

		for (const rule of WHITESPACE_APPLICABILITY_RULES) {
			expect(fired.has(rule), `no committed base exercises ${rule} — a rule nothing refuses is inert`).toBe(true)
		}
	})

	it("measures more than one comparator and more than one country", () => {
		expect(new Set(fixtures.map((fixture) => fixture.outcomeComparator)).size).toBeGreaterThan(1)
		expect(new Set(fixtures.map((fixture) => fixture.context?.caseCountry)).size).toBeGreaterThan(1)
	})

	it("gives every tracked row a reference and a note, and every enforcing row no reference", () => {
		for (const fixture of fixtures) {
			if ((fixture.status ?? "pass") === "pass") {
				expect(fixture.bugRef, `${fixture.id}: a enforcing row must not name a defect`).toBeUndefined()

				continue
			}

			expect(fixture.bugRef, `${fixture.id}: tracked without a reference`).toBeTruthy()
			expect(fixture.note, `${fixture.id}: tracked without a note`).toBeTruthy()
		}
	})

	it("keeps its ids stable and derived from the row and the transformation", () => {
		for (const fixture of fixtures) {
			const { caseID } = splitRowRef(fixture.rowRef!)
			const transformation = classifyWhitespaceTransformation(fixture.base, fixture.variant)!

			expect(fixture.id).toBe(`ws-${caseID}-${transformation}`)
		}
	})
})
