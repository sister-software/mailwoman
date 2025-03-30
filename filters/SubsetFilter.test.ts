// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Solution, SolutionMatch, SolverContext, Span } from "mailwoman/core"
import test from "tape"
import { SubsetFilter } from "./SubsetFilter.js"

test("duplicate: remove dupes", (t) => {
	const sp1 = new SolutionMatch(Span.from("A"), "house_number")
	const sp2 = new SolutionMatch(Span.from("B"), "street")

	const s1 = new Solution([sp1, sp2])
	const s2 = new Solution([sp1, sp2])

	const context: SolverContext = {
		solutions: [s1, s2, s1, s2, s1],
	}

	const c = new SubsetFilter()
	c.solve(context)

	t.deepEquals(context.solutions, [s1])
	t.end()
})

test("subset: remove subsets", (t) => {
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

	t.deepEquals(context.solutions, [s1])
	t.end()
})

test("subset: remove intersection subsets", (t) => {
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

	t.deepEquals(context.solutions, [s1])
	t.end()
})
