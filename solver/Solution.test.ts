/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import * as common from "../sdk/test/utils/index.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import Solution from "./Solution.js"

test("constructor", (t) => {
	const sol = new Solution()
	t.deepEquals(sol.pair, [])
	t.equals(sol.score, 0.0)
	t.end()
})

test("mask", (t) => {
	//                            'VVVVVV VVV  SSSSSSSSSSSS NN PPPPP AAAAAA'
	const tokenizer = new Tokenizer("Kaschk Bar, Linienstraße 40 10119 Berlin")
	common.parser.classify(tokenizer)
	common.parser.solve(tokenizer)

	t.equal(tokenizer.solutions[0]?.mask(tokenizer), "VVVVVVVVVV  SSSSSSSSSSSS NN PPPPP AAAAAA")
	t.end()
})

test("mask", (t) => {
	//                            'VVV VVVV NN SSSSSSS AAAAAA PPPPP      '
	const tokenizer = new Tokenizer("Foo Cafe 10 Main St London 10010 Earth")
	common.parser.classify(tokenizer)
	common.parser.solve(tokenizer)

	t.equal(tokenizer.solutions[0]?.mask(tokenizer), "VVVVVVVV NN SSSSSSS AAAAAA PPPPP      ")
	t.end()
})

test("mask", (t) => {
	const tokenizer = new Tokenizer("Lot 12/345 Illawarra Road Marrickville NSW 2204")
	common.parser.classify(tokenizer)
	common.parser.solve(tokenizer)

	t.equal(tokenizer.solutions[0]?.mask(tokenizer), "UUU UU NNN SSSSSSSSSSSSSS AAAAAAAAAAAA AAA PPPP")
	t.end()
})
