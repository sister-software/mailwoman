import { pathExists } from "@mailwoman/core/fs/readers"
import { type ConformanceFixture, loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditRefinementSuite,
	classifyRefinementStep,
	REFINEMENT_DERIVATION_BY_STEP,
	REFINEMENT_MONOTONICITY_LAW,
	REFINEMENT_MONOTONICITY_SUITE_PATH,
	refinementChains,
	refinementCoverage,
	REFINEMENT_STEPS,
} from "mailwoman/eval-harness/conformance/refinement-monotonicity"
import { CASES_DIR, loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import { beforeAll, describe, expect, it } from "vitest"

let fixtures: ConformanceFixture[]
let corpus: Map<string, SeedCase>
let corpusInputs: string[]

beforeAll(async () => {
	const cases = await loadRegressionCases()

	fixtures = await loadConformanceFixtures(REFINEMENT_MONOTONICITY_SUITE_PATH)
	corpus = new Map(cases.map((seedCase) => [seedCase.id, seedCase]))
	corpusInputs = cases.map((seedCase) => seedCase.input)
})

function splitRowRef(rowRef: string): { file: string; caseID: string } {
	const [file, caseID] = rowRef.split("#")

	return { file: file ?? "", caseID: caseID ?? "" }
}

describe("the committed refinement suite", () => {
	it("loads through the shared conformance loader and states one law", () => {
		expect(fixtures.length).toBeGreaterThan(0)
		expect(new Set(fixtures.map((fixture) => fixture.law))).toEqual(new Set([REFINEMENT_MONOTONICITY_LAW]))
	})

	it("passes its own audit", () => {
		expect(auditRefinementSuite(fixtures)).toEqual([])
	})

	it("ends every chain at a committed board row, verbatim", async () => {
		const chains = refinementChains(fixtures)

		expect(chains.length).toBeGreaterThan(0)

		for (const chain of chains) {
			const { file, caseID } = splitRowRef(chain.rowRef)
			const seedCase = corpus.get(caseID)

			expect(seedCase, `${chain.rowRef}: names no committed case`).toBeDefined()
			expect(chain.tip, `${chain.rowRef}: the chain's fullest query is not the committed input`).toBe(seedCase!.input)

			expect(
				await pathExists(CASES_DIR(file.replace(/^cases\//u, ""))),
				`${chain.rowRef}: names no file (${file})`
			).toBe(true)
		}
	})

	it("re-derives every base from its own variant by the step it names", () => {
		for (const fixture of fixtures) {
			const step = classifyRefinementStep(fixture.base, fixture.variant)

			expect(step, `${fixture.id}: base is not a named coarsening of variant`).not.toBeNull()
			expect(REFINEMENT_DERIVATION_BY_STEP[step!](fixture.variant)).toBe(fixture.base)
			expect(fixture.base, `${fixture.id}: base is byte-identical to variant`).not.toBe(fixture.variant)

			expect(fixture.base.length, `${fixture.id}: base is not shorter than variant`).toBeLessThan(
				fixture.variant.length
			)
		}
	})

	it("joins every chain's links, coarsest first", () => {
		for (const chain of refinementChains(fixtures)) {
			const group = fixtures.filter((fixture) => fixture.rowRef === chain.rowRef)

			expect(chain.links).toHaveLength(group.length)

			const byID = new Map(group.map((fixture) => [fixture.id, fixture]))

			for (const [index, id] of chain.links.entries()) {
				const link = byID.get(id)!
				const next = chain.links[index + 1]

				if (next) {
					expect(link.variant, `${id} → ${next}: the links do not meet`).toBe(byID.get(next)!.base)
				} else {
					expect(link.variant).toBe(chain.tip)
				}
			}
		}
	})

	it("exercises every named step, so none ships without a committed witness", () => {
		const stated = new Set(fixtures.map((fixture) => classifyRefinementStep(fixture.base, fixture.variant)))

		for (const step of REFINEMENT_STEPS) {
			expect(stated.has(step), `no committed row states ${step}`).toBe(true)
		}
	})

	it("grades every row through its own locale overlay", () => {
		for (const fixture of fixtures) {
			const { caseID } = splitRowRef(fixture.rowRef!)

			expect(fixture.context?.caseCountry, `${fixture.id}: no caseCountry`).toBe(corpus.get(caseID)!.country)
		}
	})

	it("states a chain over strictly less of the population than could state one, and reports the ratio", () => {
		const coverage = refinementCoverage(fixtures, corpusInputs)
		const chains = refinementChains(fixtures)

		expect(coverage.read).toBe(corpusInputs.length)
		expect(coverage.eligible).toBeGreaterThan(coverage.stated)
		expect(coverage.stated, "a chain is counted once however many links it carries").toBe(chains.length)
		expect(coverage.links).toBe(fixtures.length)
		expect(coverage.links).toBeGreaterThan(coverage.stated)
	})

	it("carries no tracked row — a red row here would be a live defect, and there is none", () => {
		for (const fixture of fixtures) {
			expect(fixture.status ?? "pass", `${fixture.id}`).toBe("pass")
			expect(fixture.bugRef).toBeUndefined()
		}
	})
})
