/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { agreementPattern, estimateParameters } from "./em.js"
import { type ComparisonLevel, type FellegiSunterModel, scorePair, similarityComparison } from "./fellegi-sunter.js"

const TWO_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1.0, m: 0.9, u: 0.1 },
	{ label: "different", minSimilarity: 0, m: 0.1, u: 0.9 },
]

type Person = { given?: string; family?: string }

function buildModel(lambda: number): FellegiSunterModel<Person> {
	return {
		lambda,
		comparisons: [
			similarityComparison({ name: "given", extract: (r) => r.given, levels: TWO_LEVELS }),
			similarityComparison({ name: "family", extract: (r) => r.family, levels: TWO_LEVELS }),
		],
	}
}

describe("agreementPattern", () => {
	it("reduces a record pair to per-comparison level indices", () => {
		const model = buildModel(0.1)
		// given exact, family different → [0, 1]
		expect(
			agreementPattern(model.comparisons, { given: "Jo", family: "Smith" }, { given: "jo", family: "Jones" })
		).toEqual([0, 1])
		// family missing on one side → -1
		expect(agreementPattern(model.comparisons, { given: "Jo" }, { given: "Jo", family: "Smith" })).toEqual([0, -1])
	})
})

describe("estimateParameters (EM)", () => {
	// A separable synthetic: 100 matches (mostly both-exact), 900 non-matches (mostly both-different),
	// with coincidental partial agreement in both classes. True match rate = 0.1.
	const patterns: number[][] = []
	const push = (pattern: number[], n: number) => {
		for (let i = 0; i < n; i++) {
			patterns.push([...pattern])
		}
	}
	push([0, 0], 90) // matches: both exact
	push([0, 1], 5)
	push([1, 0], 5) // match noise
	push([1, 1], 850) // non-matches: both different
	push([0, 1], 25)
	push([1, 0], 25) // coincidental agreement

	it("recovers the prior match rate from unlabeled patterns", () => {
		const result = estimateParameters(buildModel(0.2), patterns, { maxIterations: 100 })

		expect(result.converged).toBe(true)
		expect(result.lambda).toBeCloseTo(0.1, 1) // true rate 100/1000
	})

	it("separates the classes: m > u on the exact level", () => {
		const { model } = estimateParameters(buildModel(0.2), patterns, { maxIterations: 100 })

		const givenExact = model.comparisons[0]!.levels[0]!
		expect(givenExact.m).toBeGreaterThan(0.8)
		expect(givenExact.u).toBeLessThan(0.1)
		expect(givenExact.m).toBeGreaterThan(givenExact.u)
	})

	it("produces a model that scores a clear match far above a clear non-match", () => {
		const { model } = estimateParameters(buildModel(0.2), patterns, { maxIterations: 100 })

		const match = scorePair(model, { given: "Robert", family: "Smith" }, { given: "Robert", family: "Smith" })
		const nonMatch = scorePair(model, { given: "Robert", family: "Smith" }, { given: "Xavier", family: "Jones" })

		expect(match.weight).toBeGreaterThan(0)
		expect(nonMatch.weight).toBeLessThan(0)
		expect(match.weight).toBeGreaterThan(nonMatch.weight)
	})

	it("never emits a zero m/u (which would be an infinite weight)", () => {
		const { model } = estimateParameters(buildModel(0.2), patterns, { maxIterations: 100 })

		for (const comparison of model.comparisons) {
			for (const level of comparison.levels) {
				expect(level.m).toBeGreaterThan(0)
				expect(level.u).toBeGreaterThan(0)
			}
		}
	})

	it("returns the seed model unchanged for empty input", () => {
		const result = estimateParameters(buildModel(0.2), [], {})
		expect(result.converged).toBe(false)
		expect(result.iterations).toBe(0)
		expect(result.lambda).toBe(0.2)
	})
})
