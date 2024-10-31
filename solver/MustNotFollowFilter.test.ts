/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PostcodeClassification, StreetClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import MustNotFollowFilter from "./MustNotFollowFilter.js"
import { Solution } from "./Solution.js"
import SolutionPair from "./SolutionPair.js"

test("postcode_preceeds_street: remove postcode", (t) => {
	const tok = new Tokenizer()

	const s1 = new Span("A")
	s1.start = 0
	s1.end = 1

	const s2 = new Span("B")
	s2.start = 3
	s2.end = 4

	const sp1 = new SolutionPair(s1, new PostcodeClassification(1.0))
	const sp2 = new SolutionPair(s2, new StreetClassification(1.0))

	tok.solutions = [new Solution([sp1, sp2])]

	const c = new MustNotFollowFilter("StreetClassification", "PostcodeClassification")
	c.solve(tok)

	t.deepEquals(tok.solutions.length, 1)
	t.deepEquals(tok.solutions[0]!.pair.length, 1)
	t.deepEquals(tok.solutions[0]!.pair[0], sp1)
	t.end()
})
