/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, SolverContext, Span } from "@mailwoman/core"
import { expect, test } from "vitest"

import { SubsetFilter } from "./SubsetFilter.ts"

test("duplicate: remove dupes", () => {
	const sp1 = new SolutionMatch(Span.from("A"), "house_number")
	const sp2 = new SolutionMatch(Span.from("B"), "street")

	const s1 = new Solution([sp1, sp2])
	const s2 = new Solution([sp1, sp2])

	const context: SolverContext = {
		solutions: [s1, s2, s1, s2, s1],
	}

	const c = new SubsetFilter()
	c.solve(context)

	expect(context.solutions).toStrictEqual([s1])
})

test("subset: remove subsets", () => {
	const sp1 = new SolutionMatch(Span.from("A"), "house_number")
	const sp2 = new SolutionMatch(Span.from("BCD"), "street")
	const s1 = new Solution([sp1, sp2])

	const sp3 = new SolutionMatch(Span.from("A"), "house_number")
	const sp4 = new SolutionMatch(Span.from("B"), "street")
	const sp5 = new SolutionMatch(Span.from("C"), "street")
	const sp6 = new SolutionMatch(Span.from("D"), "street")
	const s2 = new Solution([sp3, sp4, sp5, sp6])

	const context: SolverContext = {
		solutions: [s1, s2],
	}

	const c = new SubsetFilter()
	c.solve(context)

	expect(context.solutions).toStrictEqual([s1])
})

test("subset: remove intersection subsets", () => {
	const sp1 = new SolutionMatch(Span.from("foo"), "street")
	const sp2 = new SolutionMatch(Span.from("bar"), "street")
	const s1 = new Solution([sp1, sp2])

	const sp3 = new SolutionMatch(Span.from("bar"), "street")
	const s2 = new Solution([sp3])

	const context: SolverContext = {
		solutions: [s1, s2],
	}

	const c = new SubsetFilter()
	c.solve(context)

	expect(context.solutions).toStrictEqual([s1])
})
