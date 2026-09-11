/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The committed canonical-form suite, checked against the corpus it was drawn from. No model, no gazetteer —
 *   two JSONL files, the pure law module and Stage 1, so this runs wherever the repo does.
 *
 *   THE POINT IS THAT NOTHING HERE IS AUTHORED. Every `base` must be the verbatim `input` of the committed
 *   board row its `rowRef` names, and every `variant` must be exactly the named transformation applied to that
 *   base. That matters more in this law than in any of its siblings: the composed and decomposed spellings of
 *   `Köln` render identically, so a hand-typed variant is a value no reviewer can check by eye. Two things
 *   hold the line — the variant is re-derived here, and the committed file writes every non-ASCII code point
 *   of a variant ESCAPED (`Ko\u0308ln`), which makes the decomposition visible in a diff and leaves the file
 *   itself byte-stable under any editor that normalizes what it saves.
 *
 *   AND THAT NO ARM IS MISSING BY ACCIDENT. Every absent arm has to name the applicability rule that refuses
 *   it, and both declared rules have to refuse something real. A suite that could quietly drop the arms it
 *   fails would report a smaller violation count, and a smaller count is indistinguishable from a law that
 *   holds.
 *
 *   THE COVERAGE READING IS PINNED, not merely printed. `eligibleByState.nfd` is zero because every committed
 *   board row is composed, which is the measured reason this suite states the decompose arm and no other. The
 *   day a decomposed row is committed that number moves, this test fails, and the failure says which arm just
 *   became stateable — which is the whole of what the pin is for.
 *
 *   STAGE 1 IS ASSERTED HERE TOO. Both forms of every committed base must reach the same normalized text, so a
 *   live violation of this law is a defect DOWNSTREAM of normalization rather than in it. That is the first
 *   question a violation raises, and it is answered without loading a model.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { normalize } from "@mailwoman/normalize"
import { type ConformanceFixture, loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditCanonicalFormSuite,
	CANONICAL_APPLICABILITY_RULES,
	CANONICAL_FORM_LAW,
	CANONICAL_FORMS,
	CANONICAL_TRANSFORMATION_BY_NAME,
	canonicalApplicability,
	canonicalFormCoverage,
	canonicalFormKey,
	canonicalFormState,
	canonicallyVariant,
	classifyCanonicalTransformation,
	NFC_NFD_SUITE_PATH,
} from "mailwoman/eval-harness/conformance/nfc-nfd"
import { CASES_DIR, loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import { join } from "path-ts"
import { beforeAll, describe, expect, it } from "vitest"

let fixtures: ConformanceFixture[]
let corpus: Map<string, SeedCase>
let corpusInputs: string[]

beforeAll(async () => {
	const cases = await loadRegressionCases()

	fixtures = await loadConformanceFixtures(NFC_NFD_SUITE_PATH)
	corpus = new Map(cases.map((seedCase) => [seedCase.id, seedCase]))
	corpusInputs = cases.map((seedCase) => seedCase.input)
})

/**
 * Split `cases/de/regression.jsonl#de-r9-nippes-koeln` into the file it names and the case id inside it.
 */
function splitRowRef(rowRef: string): { file: string; caseID: string } {
	const [file, caseID] = rowRef.split("#")

	return { file: file ?? "", caseID: caseID ?? "" }
}

describe("the committed canonical-form suite", () => {
	it("loads through the shared conformance loader", () => {
		expect(fixtures.length).toBeGreaterThan(0)
		expect(new Set(fixtures.map((fixture) => fixture.law))).toEqual(new Set([CANONICAL_FORM_LAW]))
	})

	it("passes its own audit", () => {
		expect(auditCanonicalFormSuite(fixtures)).toEqual([])
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

	it("states every variant as a byte-distinct, canonically equivalent form of its base", () => {
		for (const fixture of fixtures) {
			const form = classifyCanonicalTransformation(fixture.base, fixture.variant)

			expect(form, `${fixture.id}: variant is not a named canonical transformation`).not.toBeNull()
			expect(CANONICAL_TRANSFORMATION_BY_NAME[form!](fixture.base)).toBe(fixture.variant)
			expect(fixture.variant, `${fixture.id}: variant is byte-identical to base`).not.toBe(fixture.base)

			expect(canonicalFormKey(fixture.variant), `${fixture.id}: variant is not canonically equivalent`).toBe(
				canonicalFormKey(fixture.base)
			)
		}
	})

	it("draws only on rows that carry something a canonical transformation can act on", () => {
		for (const fixture of fixtures) {
			expect(canonicallyVariant(fixture.base), `${fixture.id}: base has no canonical variance`).toBe(true)
			expect(canonicalFormState(fixture.base), `${fixture.id}: base form`).toBe("nfc")
		}
	})

	it("writes every variant with its non-ASCII code points escaped, so a diff shows the decomposition", async () => {
		const committed = await readLocalTextFile(NFC_NFD_SUITE_PATH)

		expect(
			committed,
			"a raw decomposed sequence in the suite file is invisible to a reviewer and is rewritten by any editor that normalizes on save"
		).toBe(committed.normalize("NFC"))
	})

	it("keeps every row's context in step with the committed row it was drawn from", () => {
		for (const fixture of fixtures) {
			const seedCase = corpus.get(splitRowRef(fixture.rowRef!).caseID)!

			expect(fixture.context?.caseCountry, `${fixture.id}: caseCountry`).toBe(seedCase.country)
			expect(fixture.context?.defaultCountry, `${fixture.id}: defaultCountry`).toBe(seedCase.defaultCountry)
		}
	})

	it("grades a coordinate at the committed row's own tolerance, and pins one nowhere else", () => {
		for (const fixture of fixtures) {
			const seedCase = corpus.get(splitRowRef(fixture.rowRef!).caseID)!

			const coordinate = fixture.outcomeComparator === "assembled_coordinate"

			expect(fixture.toleranceM, `${fixture.id}: toleranceM`).toBe(coordinate ? seedCase.expectToleranceM : undefined)
		}
	})

	it("builds only on board rows the pipeline already passes", () => {
		for (const fixture of fixtures) {
			const seedCase = corpus.get(splitRowRef(fixture.rowRef!).caseID)!

			expect(seedCase.status, `${fixture.id}: ${seedCase.id} is ${seedCase.status} on the board`).toBe("pass")
		}
	})

	it("states one arm per committed row, and names each row once", () => {
		const rows = fixtures.map((fixture) => splitRowRef(fixture.rowRef!).caseID)

		expect(new Set(rows).size).toBe(rows.length)
	})

	it("omits a transformation only where an applicability rule excludes it", () => {
		for (const fixture of fixtures) {
			const present = classifyCanonicalTransformation(fixture.base, fixture.variant)

			for (const form of CANONICAL_FORMS) {
				if (form === present) continue

				const reading = canonicalApplicability(fixture.base, form)

				expect(reading.applicable, `${fixture.id}: ${form} is absent but applicable — ${reading.reason}`).toBe(false)
			}
		}
	})

	it("gives both declared rules something real to refuse", () => {
		const fired = new Set<string>()

		// Read over the WHOLE corpus rather than over the suite's own bases: every base here is canonically variant
		// by selection, so `no-canonical-variance` could never fire on one, and a rule read only against the rows
		// that were chosen for it is a rule nothing refuses.
		for (const input of corpusInputs) {
			for (const form of CANONICAL_FORMS) {
				const reading = canonicalApplicability(input, form)

				if (reading.rule) {
					fired.add(reading.rule)
				}
			}
		}

		for (const rule of CANONICAL_APPLICABILITY_RULES) {
			expect(fired.has(rule), `no committed row exercises ${rule} — a rule nothing refuses is inert`).toBe(true)
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
			const form = classifyCanonicalTransformation(fixture.base, fixture.variant)!

			expect(fixture.id).toBe(`nf-${caseID}-${form}`)
		}
	})
})

describe("the coverage reading over the committed corpus", () => {
	it("counts one transformed row per committed base, against the eligible population", () => {
		const coverage = canonicalFormCoverage(fixtures, corpusInputs)

		expect(coverage.read).toBe(corpusInputs.length)
		expect(coverage.transformed).toBe(fixtures.length)
		expect(coverage.eligible).toBeGreaterThanOrEqual(coverage.transformed)
	})

	it("finds the whole eligible population already composed, which is why only one arm is stated", () => {
		const { eligibleByState } = canonicalFormCoverage(fixtures, corpusInputs)

		expect(eligibleByState.nfc).toBeGreaterThan(0)

		expect(
			eligibleByState.nfd,
			"a committed row now arrives decomposed — the compose arm has become stateable over it, so give it a row"
		).toBe(0)

		expect(
			eligibleByState.mixed,
			"a committed row is written in neither canonical form — both arms are stateable over it, so give it both"
		).toBe(0)
	})
})

describe("Stage 1 against the committed bases", () => {
	it("converges both canonical forms of every base, so a live violation is a downstream defect", () => {
		for (const fixture of fixtures) {
			expect(normalize(fixture.variant).normalized, `${fixture.id}`).toBe(normalize(fixture.base).normalized)
		}
	})
})
