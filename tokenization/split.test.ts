/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import deepEqual from "deep-eql"
import test from "tape"
import { Span } from "./Span.js"
import split from "./split.js"
import * as funcs from "./split_funcs.js"

test("boundary: no commas or quotes", (t) => {
	const span = new Span("SoHo New York USA")
	const actual = split(span, funcs.fieldsFuncBoundary)

	t.deepEquals(actual, [new Span("SoHo New York USA")])
	t.end()
})

test("boundary: commas", (t) => {
	const span = new Span("SoHo,,, New York, USA")
	const actual = split(span, funcs.fieldsFuncBoundary)

	const token1 = new Span("SoHo", 0)
	const token2 = new Span(" New York", 7)
	const token3 = new Span(" USA", 17)

	// relationships
	token1.graph.add("next", token2)
	token2.graph.add("prev", token1)
	token2.graph.add("next", token3)
	token3.graph.add("prev", token2)

	t.true(deepEqual(actual, [token1, token2, token3]))
	t.end()
})

test("boundary: quotes", (t) => {
	const span = new Span('SoHo "New York" USA')
	const actual = split(span, funcs.fieldsFuncBoundary)

	const token1 = new Span("SoHo ", 0)
	const token2 = new Span("New York", 6)
	const token3 = new Span(" USA", 15)

	// relationships
	token1.graph.add("next", token2)
	token2.graph.add("prev", token1)
	token2.graph.add("next", token3)
	token3.graph.add("prev", token2)

	t.true(deepEqual(actual, [token1, token2, token3]))
	t.end()
})

test("whitespace: no whitespace", (t) => {
	const span = new Span("SoHo")
	const actual = split(span, funcs.fieldsFuncWhiteSpace)

	t.deepEquals(actual, [new Span("SoHo")])
	t.end()
})

test("whitespace: contains whitespace", (t) => {
	const span = new Span("SoHo\t New York \n USA")
	const actual = split(span, funcs.fieldsFuncWhiteSpace)

	const token1 = new Span("SoHo", 0)
	const token2 = new Span("New", 6)
	const token3 = new Span("York", 10)
	const token4 = new Span("USA", 17)

	// relationships
	token1.graph.add("next", token2)
	token2.graph.add("prev", token1)
	token2.graph.add("next", token3)
	token3.graph.add("prev", token2)
	token3.graph.add("next", token4)
	token4.graph.add("prev", token3)

	t.true(deepEqual(actual, [token1, token2, token3, token4]))
	t.end()
})
