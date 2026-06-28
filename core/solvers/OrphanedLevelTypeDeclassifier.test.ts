/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, Span, type SolverContext } from "@mailwoman/core"
import { expect, test } from "vitest"

import { OrphanedLevelTypeDeclassifier } from "./OrphanedLevelTypeDeclassifier.js"

test("level missing: remove orphaned level_designator", () => {
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const s2 = Span.from("B")
	s2.start = 3
	s2.end = 4

	const sp1 = new SolutionMatch(s1, "level_designator")
	const sp2 = new SolutionMatch(s2, "street")

	// The solver reassigns `context.solutions` (filter returns a new array), so read it back
	// from the context rather than the original array reference.
	const context: SolverContext = { solutions: [new Solution([sp1, sp2])] }

	new OrphanedLevelTypeDeclassifier().solve(context)

	expect(context.solutions.length).toStrictEqual(1)
	expect(context.solutions[0]!.matches.length).toStrictEqual(1)
	expect(context.solutions[0]!.matches[0]).toStrictEqual(sp2)
})

test("level present: keep level_designator", () => {
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const s2 = Span.from("B")
	s2.start = 3
	s2.end = 4

	const s3 = Span.from("C")
	s3.start = 6
	s3.end = 7

	const sp1 = new SolutionMatch(s1, "level_designator")
	const sp2 = new SolutionMatch(s2, "level")
	const sp3 = new SolutionMatch(s3, "street")

	const context: SolverContext = { solutions: [new Solution([sp1, sp2, sp3])] }

	new OrphanedLevelTypeDeclassifier().solve(context)

	expect(context.solutions.length).toStrictEqual(1)
	expect(context.solutions[0]!.matches.length).toStrictEqual(3)
	expect(context.solutions[0]!.matches[0]).toStrictEqual(sp1)
	expect(context.solutions[0]!.matches[1]).toStrictEqual(sp2)
	expect(context.solutions[0]!.matches[2]).toStrictEqual(sp3)
})

test("no level_designator at all: solution untouched", () => {
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const sp1 = new SolutionMatch(s1, "street")

	const context: SolverContext = { solutions: [new Solution([sp1])] }

	new OrphanedLevelTypeDeclassifier().solve(context)

	expect(context.solutions.length).toStrictEqual(1)
	expect(context.solutions[0]!.matches.length).toStrictEqual(1)
	expect(context.solutions[0]!.matches[0]).toStrictEqual(sp1)
})

test("orphaned level_designator with no siblings: empty solution is dropped", () => {
	// findWithout("level_designator") yields zero matches, so the solver removes the whole solution.
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const sp1 = new SolutionMatch(s1, "level_designator")

	const context: SolverContext = { solutions: [new Solution([sp1])] }

	new OrphanedLevelTypeDeclassifier().solve(context)

	expect(context.solutions.length).toStrictEqual(0)
})
