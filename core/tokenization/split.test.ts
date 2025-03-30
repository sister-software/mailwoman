// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import test from "tape"
import { Span } from "./Span.js"
import { fieldsFuncBoundary, fieldsFuncWhiteSpace, splitByField } from "./split.js"

test("boundary: no commas or quotes", (t) => {
	const span = Span.from("SoHo New York USA")
	const actual = splitByField(span, fieldsFuncBoundary)

	t.deepEquals(actual, [Span.from("SoHo New York USA")])
	t.end()
})

test("boundary: commas", (t) => {
	const span = Span.from("SoHo,,, New York, USA")
	const actual = splitByField(span, fieldsFuncBoundary)

	const token1 = Span.from("SoHo", { start: 0 })
	const token2 = Span.from(" New York", { start: 7 })
	const token3 = Span.from(" USA", { start: 17 })

	// relationships
	token1.nextSiblings.add(token2)
	token2.previousSiblings.add(token1)
	token2.nextSiblings.add(token3)
	token3.previousSiblings.add(token2)

	t.deepEquals(
		actual.map((s) => s.toJSON()),
		[token1, token2, token3].map((s) => s.toJSON())
	)

	t.end()
})

test("boundary: quotes", (t) => {
	const span = Span.from('SoHo "New York" USA')
	const actual = splitByField(span, fieldsFuncBoundary)

	const token1 = Span.from("SoHo ", { start: 0 })
	const token2 = Span.from("New York", { start: 6 })
	const token3 = Span.from(" USA", { start: 15 })

	// relationships
	token1.nextSiblings.add(token2)
	token2.previousSiblings.add(token1)
	token2.nextSiblings.add(token3)
	token3.previousSiblings.add(token2)

	t.deepEqual(
		actual.map((s) => s.toJSON()),
		[token1, token2, token3].map((s) => s.toJSON())
	)
	t.end()
})

test("whitespace: no whitespace", (t) => {
	const span = Span.from("SoHo")
	const actual = splitByField(span, fieldsFuncWhiteSpace)

	t.deepEquals(actual, [Span.from("SoHo")])
	t.end()
})

test("whitespace: contains whitespace", (t) => {
	const span = Span.from("SoHo\t New York \n USA")
	const actual = splitByField(span, fieldsFuncWhiteSpace)

	const token1 = Span.from("SoHo", { start: 0 })
	const token2 = Span.from("New", { start: 6 })
	const token3 = Span.from("York", { start: 10 })
	const token4 = Span.from("USA", { start: 17 })

	// relationships
	token1.nextSiblings.add(token2)
	token2.previousSiblings.add(token1)
	token2.nextSiblings.add(token3)
	token3.previousSiblings.add(token2)
	token3.nextSiblings.add(token4)
	token4.previousSiblings.add(token3)

	t.deepEquals(
		actual.map((s) => s.toJSON()),
		[token1, token2, token3, token4].map((s) => s.toJSON())
	)
	t.end()
})

test("fieldsFuncBoundary", (t) => {
	t.true(fieldsFuncBoundary(","))
	t.true(fieldsFuncBoundary("\n"))
	t.true(fieldsFuncBoundary("\t"))
	t.true(fieldsFuncBoundary('"'))
	t.false(fieldsFuncBoundary("A"))
	t.false(fieldsFuncBoundary("1"))
	t.end()
})

test("fieldsFuncWhiteSpace", (t) => {
	t.true(fieldsFuncWhiteSpace(" "))
	t.true(fieldsFuncWhiteSpace("\xa0")) // non-breaking space
	t.true(fieldsFuncWhiteSpace("\t"))
	t.true(fieldsFuncWhiteSpace("\n"))
	t.false(fieldsFuncWhiteSpace("A"))
	t.false(fieldsFuncWhiteSpace("1"))
	t.end()
})
