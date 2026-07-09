/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, Span } from "@mailwoman/core"
import { expect, test } from "vitest"

import { RelationshipFilter } from "./RelationshipFilter.ts"

test("postcode_preceeds_street: remove postcode", () => {
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

	expect(solutions.length).toStrictEqual(1)
	expect(solutions[0]!.matches.length).toStrictEqual(1)
	expect(solutions[0]!.matches[0]).toStrictEqual(sp1)
})

test("postcode_preceeds_street: remove postcode", () => {
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

	expect(solutions.length).toStrictEqual(1)
	expect(solutions[0]!.matches.length).toStrictEqual(1)
	expect(solutions[0]!.matches[0]).toStrictEqual(sp2)
})
