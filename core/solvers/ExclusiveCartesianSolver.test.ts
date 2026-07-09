/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, Span, TokenContext } from "@mailwoman/core"
import { expect, test } from "vitest"

import { ExclusiveCartesianSolver } from "./ExclusiveCartesianSolver.ts"

/**
 * The static `exclusiveCartesian` is the pure core of this solver: it computes the cartesian product across
 * classification solutions, keeping only combinations whose spans do not overlap.
 */

test("exclusiveCartesian: combines one match from each classification", () => {
	const hn = Span.from("100")
	hn.start = 0
	hn.end = 3

	const street = Span.from("main")
	street.start = 4
	street.end = 8

	const s1 = new Solution([new SolutionMatch(hn, "house_number")])
	const s2 = new Solution([new SolutionMatch(street, "street")])

	const results = ExclusiveCartesianSolver.exclusiveCartesian(s1, s2)

	// A single non-overlapping pairing should be produced.
	expect(results.length).toStrictEqual(1)

	const classifications = results[0]!.matches.map((m) => m.classification).sort()
	expect(classifications).toStrictEqual(["house_number", "street"])
})

test("exclusiveCartesian: drops combinations whose spans intersect", () => {
	const hn = Span.from("AAA")
	hn.start = 0
	hn.end = 3

	// Overlaps `hn` (2 < 3) — any combination containing both must be filtered out.
	const overlapping = Span.from("BBB")
	overlapping.start = 2
	overlapping.end = 5

	// Disjoint from `hn` — this combination must survive.
	const disjoint = Span.from("CCC")
	disjoint.start = 10
	disjoint.end = 13

	const s1 = new Solution([new SolutionMatch(hn, "house_number")])
	const s2 = new Solution([new SolutionMatch(overlapping, "street"), new SolutionMatch(disjoint, "street")])

	const results = ExclusiveCartesianSolver.exclusiveCartesian(s1, s2)

	// Only the non-overlapping pairing { AAA, CCC } survives.
	expect(results.length).toStrictEqual(1)

	const values = results[0]!.matches.map((m) => m.value).sort()
	expect(values).toStrictEqual(["AAA", "CCC"])
})

test("exclusiveCartesian: empty input yields no solutions", () => {
	expect(ExclusiveCartesianSolver.exclusiveCartesian()).toStrictEqual([])
})

test("solve: appends the cartesian product of classified tokens to the context", () => {
	const context = new TokenContext("100 main 90210")
	const [section] = context.sections
	const children = Array.from(section!.children)

	children[0]!.classifications.add("house_number")
	children[1]!.classifications.add("street")
	children[2]!.classifications.add("postcode")

	new ExclusiveCartesianSolver().solve(context)

	// The full combination (one of each classification) must be present among the solutions.
	const full = context.solutions.find((solution) => {
		const labels = new Set(solution.matches.map((m) => m.classification))

		return labels.has("house_number") && labels.has("street") && labels.has("postcode")
	})

	expect(full).toBeDefined()
	expect(full!.matches.length).toStrictEqual(3)

	// No solution may contain two matches with intersecting spans.
	for (const solution of context.solutions) {
		const overlaps = solution.matches.some((p1, i1) =>
			solution.matches.some((p2, i2) => i2 > i1 && p1.span.intersects(p2.span))
		)

		expect(overlaps).toStrictEqual(false)
	}
})
