/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { HouseNumberClassification, StreetClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import Solution from "./Solution.js"
import SolutionPair from "./SolutionPair.js"
import SubsetFilter from "./SubsetFilter.js"

test("duplicate: remove dupes", (t) => {
	const tok = new Tokenizer()

	const sp1 = new SolutionPair(new Span("A"), new HouseNumberClassification(1.0))
	const sp2 = new SolutionPair(new Span("B"), new StreetClassification(1.0))

	const s1 = new Solution([sp1, sp2])
	const s2 = new Solution([sp1, sp2])

	tok.solutions = [s1, s2, s1, s2, s1]

	const c = new SubsetFilter()
	c.solve(tok)

	t.deepEquals(tok.solutions, [s1])
	t.end()
})

test("subset: remove subsets", (t) => {
	const tok = new Tokenizer()

	const sp1 = new SolutionPair(new Span("A"), new HouseNumberClassification(1.0))
	const sp2 = new SolutionPair(new Span("BCD"), new StreetClassification(1.0))
	const s1 = new Solution([sp1, sp2])

	const sp3 = new SolutionPair(new Span("A"), new HouseNumberClassification(1.0))
	const sp4 = new SolutionPair(new Span("B"), new StreetClassification(1.0))
	const sp5 = new SolutionPair(new Span("C"), new StreetClassification(1.0))
	const sp6 = new SolutionPair(new Span("D"), new StreetClassification(1.0))
	const s2 = new Solution([sp3, sp4, sp5, sp6])

	tok.solutions = [s1, s2]

	const c = new SubsetFilter()
	c.solve(tok)

	t.deepEquals(tok.solutions, [s1])
	t.end()
})

test("subset: remove intersection subsets", (t) => {
	const tok = new Tokenizer()

	const sp1 = new SolutionPair(new Span("foo"), new StreetClassification(1.0))
	const sp2 = new SolutionPair(new Span("bar"), new StreetClassification(1.0))
	const s1 = new Solution([sp1, sp2])

	const sp3 = new SolutionPair(new Span("bar"), new StreetClassification(1.0))
	const s2 = new Solution([sp3])

	tok.solutions = [s1, s2]

	const c = new SubsetFilter()
	c.solve(tok)

	t.deepEquals(tok.solutions, [s1])
	t.end()
})
