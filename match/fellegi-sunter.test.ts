/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	type ComparisonLevel,
	type FellegiSunterModel,
	decide,
	levelWeight,
	priorWeight,
	probabilityFromWeight,
	scorePair,
	similarityComparison,
} from "./fellegi-sunter.js"

// The StatCan/ONS first-name levels (the recipe the research pass surfaced). m/u are project-specific
// — re-estimated by EM in practice — but they anchor the weight math here.
const NAME_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1.0, m: 0.7798, u: 0.00149 },
	{ label: "high", minSimilarity: 0.88, m: 0.15, u: 0.01 },
	{ label: "different", minSimilarity: 0, m: 0.003, u: 0.9727 },
]

describe("levelWeight", () => {
	it("reproduces the StatCan first-name weights (log2 m/u)", () => {
		expect(levelWeight(NAME_LEVELS[0]!)).toBeCloseTo(9.03, 2) // exact
		expect(levelWeight(NAME_LEVELS[2]!)).toBeCloseTo(-8.34, 2) // different
	})

	it("handles a zero u (certain evidence) without dividing by zero", () => {
		expect(levelWeight({ label: "x", m: 0.5, u: 0 })).toBe(Infinity)
		expect(levelWeight({ label: "x", m: 0, u: 0 })).toBe(0)
	})
})

describe("priorWeight", () => {
	it("is 0 at λ = 0.5 and negative for a rare prior", () => {
		expect(priorWeight(0.5)).toBe(0)
		expect(priorWeight(0.0001)).toBeCloseTo(Math.log2(0.0001 / 0.9999), 6)
		expect(priorWeight(0.0001)).toBeLessThan(0)
	})
})

describe("probabilityFromWeight", () => {
	it("maps weight 0 to 0.5 and is monotonic + saturating", () => {
		expect(probabilityFromWeight(0)).toBe(0.5)
		expect(probabilityFromWeight(9.03)).toBeGreaterThan(0.99)
		expect(probabilityFromWeight(-8.34)).toBeLessThan(0.01)
	})

	it("stays in [0,1] at extreme weights (no overflow)", () => {
		expect(probabilityFromWeight(5000)).toBe(1)
		expect(probabilityFromWeight(-5000)).toBe(0)
	})
})

describe("similarityComparison.assess", () => {
	const cmp = similarityComparison<{ given?: string }>({
		name: "given",
		extract: (r) => r.given,
		levels: NAME_LEVELS,
	})

	it("returns -1 when either value is missing", () => {
		expect(cmp.assess({ given: "Robert" }, {})).toBe(-1)
		expect(cmp.assess({}, { given: "Robert" })).toBe(-1)
	})

	it("lands an exact match in the top level", () => {
		expect(cmp.assess({ given: "Robert" }, { given: "robert" })).toBe(0)
	})

	it("lands a typo'd name in the 'high' level", () => {
		expect(cmp.assess({ given: "Martha" }, { given: "Marhta" })).toBe(1)
	})

	it("lands a clearly different name in the catch-all", () => {
		expect(cmp.assess({ given: "Robert" }, { given: "Xavier" })).toBe(2)
	})
})

describe("scorePair", () => {
	type Person = { given?: string; family?: string }
	const model: FellegiSunterModel<Person> = {
		lambda: 0.0001,
		comparisons: [
			similarityComparison({ name: "given", extract: (r) => r.given, levels: NAME_LEVELS }),
			similarityComparison({ name: "family", extract: (r) => r.family, levels: NAME_LEVELS }),
		],
	}

	it("scores a matching pair well above a non-matching pair", () => {
		const match = scorePair(model, { given: "Robert", family: "Smith" }, { given: "Robert", family: "Smith" })
		const nonMatch = scorePair(model, { given: "Robert", family: "Smith" }, { given: "Xavier", family: "Jones" })

		expect(match.weight).toBeGreaterThan(nonMatch.weight)
		expect(match.probability).toBeGreaterThan(0.9)
		expect(nonMatch.probability).toBeLessThan(0.01)
		expect(match.contributions.map((c) => c.level)).toEqual(["exact", "exact"])
	})

	it("contributes zero weight for a missing field (no evidence)", () => {
		const score = scorePair(model, { given: "Robert" }, { given: "Robert", family: "Smith" })
		const family = score.contributions.find((c) => c.name === "family")
		expect(family).toEqual({ name: "family", level: null, weight: 0 })
	})
})

describe("decide", () => {
	const score = (weight: number) => ({ weight, probability: probabilityFromWeight(weight), contributions: [] })

	it("links, reviews, or rejects against the thresholds", () => {
		const thresholds = { upper: 4, lower: -4 }
		expect(decide(score(6), thresholds)).toBe("match")
		expect(decide(score(0), thresholds)).toBe("review")
		expect(decide(score(-6), thresholds)).toBe("non-match")
	})
})
