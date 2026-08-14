/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode scorePairwiseGrouping}/{@linkcode groupPredicateFromMap} (decision 4)
 *   — pure unit tests, no database, since the metrics module's whole point is being usable independently
 *   of `filer.db`.
 */

import { describe, expect, it } from "vitest"

import { groupPredicateFromMap, scorePairwiseGrouping } from "./linkage-metrics.ts"

describe("scorePairwiseGrouping", () => {
	it("scores a perfect prediction as precision/recall/F1 all 1", () => {
		// truth: {a,b} together, {c,d} together. Prediction agrees exactly.
		const truth = new Map([
			["a", "g1"],
			["b", "g1"],
			["c", "g2"],
			["d", "g2"],
		])

		const score = scorePairwiseGrouping(
			["a", "b", "c", "d"],
			groupPredicateFromMap(truth),
			groupPredicateFromMap(truth)
		)

		expect(score.truePositivePairs).toBe(2) // {a,b} and {c,d}
		expect(score.falsePositivePairs).toBe(0)
		expect(score.falseNegativePairs).toBe(0)
		expect(score.truthPositivePairs).toBe(2)
		expect(score.predictedPositivePairs).toBe(2)
		expect(score.totalPairs).toBe(6) // 4 choose 2
		expect(score.precision).toBe(1)
		expect(score.recall).toBe(1)
		expect(score.f1).toBe(1)
	})

	it("reports precision as null (not 0) when the prediction makes zero positive calls but truth has positives", () => {
		const truth = new Map([
			["a", "g1"],
			["b", "g1"],
			["c", "singleton:c"],
		])

		// Every id predicted into its own singleton group — no predicted-positive pair at all.
		const predicted = new Map([
			["a", "p1"],
			["b", "p2"],
			["c", "p3"],
		])

		const score = scorePairwiseGrouping(["a", "b", "c"], groupPredicateFromMap(truth), groupPredicateFromMap(predicted))

		expect(score.truePositivePairs).toBe(0)
		expect(score.predictedPositivePairs).toBe(0)
		expect(score.truthPositivePairs).toBe(1) // {a,b}
		expect(score.precision).toBeNull()
		expect(score.recall).toBe(0)
		// I2: precision is undefined here, so F1 is undefined too — NOT 0. "Made no positive call" is not "scored zero".
		expect(score.f1).toBeNull()
	})

	it("reports recall as null (not 0) when truth has zero positive pairs but the prediction merges records anyway", () => {
		// Every id its own truth singleton — no truth-positive pair exists at all.
		const truth = new Map([
			["a", "singleton:a"],
			["b", "singleton:b"],
			["c", "singleton:c"],
		])

		// Prediction wrongly merges all three into one group — a pure false-merge case.
		const predicted = new Map([
			["a", "p1"],
			["b", "p1"],
			["c", "p1"],
		])

		const score = scorePairwiseGrouping(["a", "b", "c"], groupPredicateFromMap(truth), groupPredicateFromMap(predicted))

		expect(score.truePositivePairs).toBe(0)
		expect(score.falsePositivePairs).toBe(3) // {a,b}, {a,c}, {b,c}
		expect(score.truthPositivePairs).toBe(0)
		expect(score.predictedPositivePairs).toBe(3)
		expect(score.precision).toBe(0) // defined (denominator > 0), just zero
		expect(score.recall).toBeNull()
		expect(score.f1).toBeNull()
	})

	it("reports F1 as null (not 0) for a PERFECT prediction over an all-singleton truth — I2's worked example", () => {
		// Nothing to merge, nothing merged: the prediction agreed with the truth on all 3 pairs. Reporting `0` here
		// (the pre-fix behaviour) made a flawless run arithmetically indistinguishable from a total failure.
		const truth = new Map([
			["a", "singleton:a"],
			["b", "singleton:b"],
			["c", "singleton:c"],
		])

		const score = scorePairwiseGrouping(["a", "b", "c"], groupPredicateFromMap(truth), groupPredicateFromMap(truth))

		expect(score.truePositivePairs).toBe(0)
		expect(score.falsePositivePairs).toBe(0)
		expect(score.falseNegativePairs).toBe(0)
		expect(score.totalPairs).toBe(3)
		expect(score.precision).toBeNull()
		expect(score.recall).toBeNull()
		expect(score.f1).toBeNull()
	})

	it("reports F1 as 0 (not null) when BOTH components are defined and nothing was recovered — a measured miss", () => {
		// truth: {a,b} together. prediction: {c,d} together. Both denominators are populated, zero overlap.
		const truth = new Map([
			["a", "g1"],
			["b", "g1"],
			["c", "singleton:c"],
			["d", "singleton:d"],
		])

		const predicted = new Map([
			["a", "p1"],
			["b", "p2"],
			["c", "p3"],
			["d", "p3"],
		])

		const score = scorePairwiseGrouping(
			["a", "b", "c", "d"],
			groupPredicateFromMap(truth),
			groupPredicateFromMap(predicted)
		)

		expect(score.truePositivePairs).toBe(0)
		expect(score.precision).toBe(0)
		expect(score.recall).toBe(0)
		expect(score.f1).toBe(0)
	})

	it("computes a worked partial-overlap example by hand", () => {
		// truth: {a,b,c} one family, d/e standalone.
		const truth = new Map([
			["a", "g1"],
			["b", "g1"],
			["c", "g1"],
			["d", "singleton:d"],
			["e", "singleton:e"],
		])

		// predicted: {a,b} merged (misses c — a false negative), {d,e} wrongly merged (a false positive).
		const predicted = new Map([
			["a", "p1"],
			["b", "p1"],
			["c", "p2"],
			["d", "p3"],
			["e", "p3"],
		])

		const score = scorePairwiseGrouping(
			["a", "b", "c", "d", "e"],
			groupPredicateFromMap(truth),
			groupPredicateFromMap(predicted)
		)

		// truth-positive pairs: {a,b},{a,c},{b,c} = 3. predicted-positive pairs: {a,b},{d,e} = 2.
		// true positive: {a,b} only = 1. false positive: {d,e} = 1. false negative: {a,c},{b,c} = 2.
		expect(score.truePositivePairs).toBe(1)
		expect(score.falsePositivePairs).toBe(1)
		expect(score.falseNegativePairs).toBe(2)
		expect(score.truthPositivePairs).toBe(3)
		expect(score.predictedPositivePairs).toBe(2)
		expect(score.totalPairs).toBe(10) // 5 choose 2
		expect(score.precision).toBe(0.5) // 1/2
		expect(score.recall).toBeCloseTo(1 / 3)
		expect(score.f1).toBeCloseTo((2 * 0.5 * (1 / 3)) / (0.5 + 1 / 3))
	})
})

describe("groupPredicateFromMap", () => {
	it("treats two ids missing from the map entirely as NOT the same group", () => {
		const predicate = groupPredicateFromMap(new Map<string, string>())

		expect(predicate("a", "b")).toBe(false)
	})

	it("treats one id missing from the map as NOT the same group as one that is present", () => {
		const predicate = groupPredicateFromMap(new Map([["a", "g1"]]))

		expect(predicate("a", "b")).toBe(false)
		expect(predicate("b", "a")).toBe(false)
	})

	it("treats two ids mapped to the same group id as the same group", () => {
		const predicate = groupPredicateFromMap(
			new Map([
				["a", "g1"],
				["b", "g1"],
			])
		)

		expect(predicate("a", "b")).toBe(true)
	})
})
