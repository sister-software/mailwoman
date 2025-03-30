// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import test from "tape"
import { Span } from "./Span.js"

test("constructor: defaults", (t) => {
	const span = Span.from()
	t.equals(span.body, "")
	t.equals(span.normalized, "")
	t.equals(span.start, 0)
	t.equals(span.end, 0)

	t.equals(span.classifications.size, 0)
	t.false(span.flags.has("numeric"))
	t.false(span.flags.has("ends_with_period"))
	t.end()
})

test("constructor: string", (t) => {
	const span = Span.from("Example")
	t.equals(span.body, "Example")
	t.equals(span.normalized, "example")
	t.equals(span.start, 0)
	t.equals(span.end, 7)
	t.false(span.flags.has("numeric"))
	t.false(span.flags.has("ends_with_period"))
	t.end()
})

test("constructor: string + start", (t) => {
	const span = Span.from("Example", { start: 10 })
	t.equals(span.body, "Example")
	t.equals(span.normalized, "example")
	t.equals(span.start, 10)
	t.equals(span.end, 17)
	t.false(span.flags.has("numeric"))
	t.false(span.flags.has("ends_with_period"))
	t.end()
})

test("setBody: empty string", (t) => {
	const span = Span.from("Example")
	span.body = ""
	t.equals(span.body, "")
	t.equals(span.normalized, "")
	t.equals(span.start, 0)
	t.equals(span.end, 0)
	t.false(span.flags.has("numeric"))
	t.false(span.flags.has("ends_with_period"))
	t.end()
})

test("setBody: update body", (t) => {
	const span = Span.from("Example")
	t.equals(span.body, "Example")
	span.body = "Foo"
	t.equals(span.body, "Foo")
	t.end()
})

test("setBody: update norm", (t) => {
	const span = Span.from("Example")
	t.equals(span.normalized, "example")
	span.body = "Foo"
	t.equals(span.normalized, "foo")
	t.end()
})

test("setBody: update end", (t) => {
	const span = Span.from("Example", { start: 10 })
	t.equals(span.start, 10)
	t.equals(span.end, 17)
	span.body = "Foo"
	t.equals(span.start, 10)
	t.equals(span.end, 13)
	t.end()
})

test("setBody: update contains.numerals", (t) => {
	const span = Span.from("Example")

	t.true(span.flags.has("alpha"))
	t.false(span.flags.has("numeral"))
	t.false(span.flags.has("alphanumeric"))

	span.body = "foo1bar"
	t.true(span.flags.has("alphanumeric"))
	t.true(span.flags.has("numeral"))
	t.end()
})

test("setBody: update contains.final.period", (t) => {
	const span = Span.from("Example")
	t.false(span.flags.has("ends_with_period"))
	span.body = "Foo."
	t.true(span.flags.has("ends_with_period"))
	t.end()
})

test("setBody: trim text when greater than 140 characters with spaces", (t) => {
	const span =
		Span.from(`Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
      Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`)
	t.equals(span.start, 0)
	t.equals(span.end, 140)
	t.end()
})

test("setBody: do not trim text when it's 140 characters", (t) => {
	const span = Span.from(
		"LoremipsumdolorsitametconsecteturadipiscingelitseddoeiusmodtemporincididuntutlaboreetdoloremagnaaliquaUtenimadminimveniamquisnostrudexercita"
	)
	t.equals(span.start, 0)
	t.equals(span.end, 140)
	t.end()
})

test("intersects: basic", (t) => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")
	t.true(spanA.intersects(spanB))
	t.true(spanB.intersects(spanA))
	t.end()
})

test("intersects: advanced", (t) => {
	const spanA = Span.from("A")
	spanA.start = 0
	spanA.end = 1

	const spanB = Span.from("B")
	spanB.start = 1
	spanB.end = 2

	const spanC = Span.from("C")
	spanC.start = 0
	spanC.end = 2

	t.false(spanA.intersects(spanB))
	t.false(spanB.intersects(spanA))
	t.true(spanA.intersects(spanC))
	t.true(spanC.intersects(spanA))
	t.true(spanB.intersects(spanC))
	t.true(spanC.intersects(spanB))
	t.end()
})

test("covers: basic", (t) => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")
	t.true(spanA.covers(spanB))
	t.true(spanB.covers(spanA))
	t.end()
})

test("covers: advanced", (t) => {
	const spanA = Span.from("A")
	spanA.start = 0
	spanA.end = 10

	const spanB = Span.from("B")
	spanB.start = 2
	spanB.end = 10

	const spanC = Span.from("C")
	spanC.start = 0
	spanC.end = 5

	t.true(spanA.covers(spanB))
	t.false(spanB.covers(spanA))
	t.true(spanA.covers(spanC))
	t.false(spanC.covers(spanA))
	t.false(spanB.covers(spanC))
	t.false(spanC.covers(spanB))
	t.end()
})

test("distance: same", (t) => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")

	t.equal(0, spanA.distance(spanB))
	t.equal(0, spanB.distance(spanA))
	t.end()
})

test("distance: right", (t) => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")
	spanB.start = 5
	spanB.end = 6

	t.equal(4, spanA.distance(spanB))
	t.equal(4, spanB.distance(spanA))
	t.end()
})

test("distance: left", (t) => {
	const spanA = Span.from("A")
	spanA.start = 2
	spanA.end = 3

	const spanB = Span.from("B")

	t.equal(1, spanA.distance(spanB))
	t.equal(1, spanB.distance(spanA))
	t.end()
})

test("connectSiblings - array list", (t) => {
	const spans = [Span.from("A"), Span.from("B"), Span.from("C")] as const
	Span.connectSiblings(...spans)

	t.deepEquals(spans[0].nextSibling, spans[1])
	t.notOk(spans[0].previousSibling)
	t.deepEquals(spans[1].nextSibling, spans[2])
	t.deepEquals(spans[1].previousSibling, spans[0])
	t.notOk(spans[2].nextSibling)
	t.deepEquals(spans[2].previousSibling, spans[1])
	t.end()
})

test("connectSiblings - list of items", (t) => {
	const a = Span.from("A")
	const b = Span.from("B")
	const c = Span.from("C")

	Span.connectSiblings(a, b, c)

	t.deepEquals(a.nextSibling, b)
	t.notOk(a.previousSibling)
	t.deepEquals(b.nextSibling, c)
	t.deepEquals(b.previousSibling, a)
	t.notOk(c.nextSibling)
	t.deepEquals(c.previousSibling, b)
	t.end()
})
