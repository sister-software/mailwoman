/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { StreetClassification, UnitClassification, UnitTypeClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import OrphanedUnitTypeDeclassifier from "./OrphanedUnitTypeDeclassifier.js"
import { Solution } from "./Solution.js"
import SolutionPair from "./SolutionPair.js"

test("UnitClassification missing: remove UnitTypeClassification", (t) => {
	const tok = new Tokenizer()

	const s1 = new Span("A")
	s1.start = 0
	s1.end = 1

	const s2 = new Span("B")
	s2.start = 3
	s2.end = 4

	const sp1 = new SolutionPair(s1, new UnitTypeClassification(1.0))
	const sp2 = new SolutionPair(s2, new StreetClassification(1.0))

	tok.solutions = [new Solution([sp1, sp2])]

	const c = new OrphanedUnitTypeDeclassifier()
	c.solve(tok)

	t.deepEquals(tok.solutions.length, 1)
	t.deepEquals(tok.solutions[0]!.pair.length, 1)
	t.deepEquals(tok.solutions[0]!.pair[0], sp2)
	t.end()
})

test("UnitClassification present: do not remove UnitTypeClassification", (t) => {
	const tok = new Tokenizer()

	const s1 = new Span("A")
	s1.start = 0
	s1.end = 1

	const s2 = new Span("B")
	s2.start = 3
	s2.end = 4

	const s3 = new Span("C")
	s2.start = 6
	s2.end = 7

	const sp1 = new SolutionPair(s1, new UnitTypeClassification(1.0))
	const sp2 = new SolutionPair(s2, new UnitClassification(1.0))
	const sp3 = new SolutionPair(s3, new StreetClassification(1.0))

	tok.solutions = [new Solution([sp1, sp2, sp3])]

	const c = new OrphanedUnitTypeDeclassifier()
	c.solve(tok)

	t.deepEquals(tok.solutions.length, 1)
	t.deepEquals(tok.solutions[0]!.pair.length, 3)
	t.deepEquals(tok.solutions[0]!.pair[0], sp1)
	t.deepEquals(tok.solutions[0]!.pair[1], sp2)
	t.deepEquals(tok.solutions[0]!.pair[2], sp3)
	t.end()
})
