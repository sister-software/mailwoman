/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { Span } from "./Span.js"
import { fieldsFuncBoundary, fieldsFuncWhiteSpace, splitByField } from "./split.js"

test("boundary: no commas or quotes", () => {
	const span = Span.from("SoHo New York USA")
	const actual = splitByField(span, fieldsFuncBoundary)

	expect(actual).toStrictEqual([Span.from("SoHo New York USA")])
})

test("boundary: commas", () => {
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

	expect(actual.map((s) => s.toJSON())).toStrictEqual([token1, token2, token3].map((s) => s.toJSON()))
})

test("boundary: quotes", () => {
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

	expect(actual.map((s) => s.toJSON())).toStrictEqual([token1, token2, token3].map((s) => s.toJSON()))
})

test("whitespace: no whitespace", () => {
	const span = Span.from("SoHo")
	const actual = splitByField(span, fieldsFuncWhiteSpace)

	expect(actual).toStrictEqual([Span.from("SoHo")])
})

test("whitespace: contains whitespace", () => {
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

	expect(actual.map((s) => s.toJSON())).toStrictEqual([token1, token2, token3, token4].map((s) => s.toJSON()))
})

test("fieldsFuncBoundary", () => {
	expect(fieldsFuncBoundary(",")).toBe(true)
	expect(fieldsFuncBoundary("\n")).toBe(true)
	expect(fieldsFuncBoundary("\t")).toBe(true)
	expect(fieldsFuncBoundary('"')).toBe(true)
	expect(fieldsFuncBoundary("A")).toBe(false)
	expect(fieldsFuncBoundary("1")).toBe(false)
})

test("fieldsFuncWhiteSpace", () => {
	expect(fieldsFuncWhiteSpace(" ")).toBe(true)

	// non-breaking space
	expect(fieldsFuncWhiteSpace("\xa0")).toBe(true)

	expect(fieldsFuncWhiteSpace("\t")).toBe(true)
	expect(fieldsFuncWhiteSpace("\n")).toBe(true)
	expect(fieldsFuncWhiteSpace("A")).toBe(false)
	expect(fieldsFuncWhiteSpace("1")).toBe(false)
})
