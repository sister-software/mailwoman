/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Test pairwise grouping metrics without a database dependency.
 */

import { groupPredicateFromMap, scorePairwiseGrouping } from "@mailwoman/filer/tools/linkage-metrics"
import { describe, expect, it } from "vitest"

describe("scorePairwiseGrouping", () => {
	it("scores a perfect prediction as precision/recall/F1 all 1", () => {
		// Two truth groups; prediction matches them.
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

		// Predict every ID as a singleton; no positive pairs.
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
		// Undefined precision makes F1 undefined, not zero.
		expect(score.f1).toBeNull()
	})

	it("reports recall as null (not 0) when truth has zero positive pairs but the prediction merges records anyway", () => {
		// Truth contains only singletons.
		const truth = new Map([
			["a", "singleton:a"],
			["b", "singleton:b"],
			["c", "singleton:c"],
		])

		// Prediction merges all three incorrectly.
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
		// The prediction matches an all-singleton truth, but both positive-pair denominators are empty.
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
		// Truth and prediction each contain a different pair; both denominators are nonzero.
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
		// Truth groups a/b/c; d and e are singletons.
		const truth = new Map([
			["a", "g1"],
			["b", "g1"],
			["c", "g1"],
			["d", "singleton:d"],
			["e", "singleton:e"],
		])

		// Prediction misses c and incorrectly merges d/e.
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

		// Expected: 3 truth pairs, 2 predicted pairs, 1 true positive, 1 false positive, 2 false negatives.
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
