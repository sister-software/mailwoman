// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Solution, SolutionMatch, Span } from "mailwoman/core"
import test from "tape"
import { RelationshipFilter } from "./RelationshipFilter.js"

test("postcode_preceeds_street: remove postcode", (t) => {
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const s2 = Span.from("B")
	s2.start = 3
	s2.end = 4

	const sp1 = new SolutionMatch(s1, "postcode")
	const sp2 = new SolutionMatch(s2, "street")

	const solutions = [new Solution([sp1, sp2])]

	const c = new RelationshipFilter([["street", "follows", "postcode"]])
	c.solve({ solutions })

	t.deepEquals(solutions.length, 1)
	t.deepEquals(solutions[0]!.matches.length, 1)
	t.deepEquals(solutions[0]!.matches[0], sp1)
	t.end()
})

test("postcode_preceeds_street: remove postcode", (t) => {
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const s2 = Span.from("B")
	s2.start = 3
	s2.end = 4

	const sp1 = new SolutionMatch(s1, "postcode")
	const sp2 = new SolutionMatch(s2, "street")

	const solutions = [new Solution([sp1, sp2])]

	const c = new RelationshipFilter([["postcode", "precedes", "street"]])

	c.solve({
		solutions,
	})

	t.deepEquals(solutions.length, 1)
	t.deepEquals(solutions[0]!.matches.length, 1)
	t.deepEquals(solutions[0]!.matches[0], sp2)
	t.end()
})
