/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { estimateParameters } from "./em.js"
import { type ComparisonLevel, type FellegiSunterModel, scorePair, similarityComparison } from "./fellegi-sunter.js"
import { buildTermFrequencyTable, withTermFrequency } from "./tf.js"

const EXACT_DIFF: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1.0, m: 0.9, u: 0.05 },
	{ label: "different", minSimilarity: 0, m: 0.1, u: 0.95 },
]

// A column dominated by "Smith", with a single rare "Vijayan".
const NAMES = [...Array(900).fill("Smith"), ...Array(99).fill("Jones"), "Vijayan"]

describe("buildTermFrequencyTable", () => {
	const table = buildTermFrequencyTable(NAMES)

	it("reports relative frequencies, normalizing the lookup", () => {
		expect(table.frequency("Smith")).toBeCloseTo(0.9, 5)
		expect(table.frequency("VIJAYAN")).toBeCloseTo(0.001, 5)
		expect(table.frequency("never-seen")).toBe(0)
	})

	it("exposes total and distinct counts", () => {
		expect(table.total).toBe(1000)
		expect(table.distinct).toBe(3)
	})

	it("is empty-safe", () => {
		const empty = buildTermFrequencyTable([])
		expect(empty.frequency("anything")).toBe(0)
		expect(empty.total).toBe(0)
	})
})

describe("withTermFrequency + scorePair", () => {
	type Person = { given: string }
	const table = buildTermFrequencyTable(NAMES)
	const model: FellegiSunterModel<Person> = {
		lambda: 0.001,
		comparisons: [
			withTermFrequency(similarityComparison<Person>({ name: "given", extract: (r) => r.given, levels: EXACT_DIFF }), {
				table,
				value: (a) => a.given,
			}),
		],
	}

	it("scores a rare-name agreement far above a common-name agreement", () => {
		const rare = scorePair(model, { given: "Vijayan" }, { given: "Vijayan" })
		const common = scorePair(model, { given: "Smith" }, { given: "Smith" })

		expect(rare.weight).toBeGreaterThan(common.weight)
		// the gap is log2(freq_smith / freq_vijayan) = log2(0.9 / 0.001) ≈ 9.8 bits
		expect(rare.weight - common.weight).toBeCloseTo(Math.log2(0.9 / 0.001), 1)
	})

	it("treats an unseen value as ultra-rare, floored by minimumFrequency", () => {
		const unseen = scorePair(model, { given: "Zylphqua" }, { given: "Zylphqua" })
		const common = scorePair(model, { given: "Smith" }, { given: "Smith" })
		expect(unseen.weight).toBeGreaterThan(common.weight)
	})

	it("leaves a non-agreeing pair unadjusted (TF only fires on the exact level)", () => {
		// Different names land in the 'different' level, which the adjustment does not touch.
		const score = scorePair(model, { given: "Smith" }, { given: "Jones" })
		expect(score.contributions[0]!.level).toBe("different")
	})
})

describe("term-frequency composes with EM", () => {
	type Person = { given: string }
	const table = buildTermFrequencyTable(NAMES)

	it("keeps the adjustment on the fitted comparison after EM re-estimates the base u", () => {
		const model: FellegiSunterModel<Person> = {
			lambda: 0.2,
			comparisons: [
				withTermFrequency(
					similarityComparison<Person>({ name: "given", extract: (r) => r.given, levels: EXACT_DIFF }),
					{ table, value: (a) => a.given }
				),
			],
		}

		const { model: fitted } = estimateParameters(model, [[0], [0], [1], [1], [1]], { maxIterations: 50 })
		expect(fitted.comparisons[0]!.termFrequency).toBeDefined()
	})
})
