/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { Span } from "./Span.js"

test("constructor: defaults", () => {
	const span = Span.from()

	expect(span.body).toStrictEqual("")
	expect(span.normalized).toStrictEqual("")
	expect(span.start).toStrictEqual(0)
	expect(span.end).toStrictEqual(0)

	expect(span.classifications.size).toEqual(0)
	expect(span.flags.has("numeric")).toBe(false)
	expect(span.flags.has("ends_with_period")).toBe(false)
})

test("constructor: string", () => {
	const span = Span.from("Example")

	expect(span.body).toStrictEqual("Example")
	expect(span.normalized).toStrictEqual("example")
	expect(span.start).toStrictEqual(0)
	expect(span.end).toStrictEqual(7)
	expect(span.flags.has("numeric")).toBe(false)
	expect(span.flags.has("ends_with_period")).toBe(false)
})

test("constructor: string + start", () => {
	const span = Span.from("Example", { start: 10 })

	expect(span.body).toStrictEqual("Example")
	expect(span.normalized).toStrictEqual("example")
	expect(span.start).toStrictEqual(10)
	expect(span.end).toStrictEqual(17)
	expect(span.flags.has("numeric")).toBe(false)
	expect(span.flags.has("ends_with_period")).toBe(false)
})

test("setBody: empty string", () => {
	const span = Span.from("Example")

	span.body = ""
	expect(span.body).toStrictEqual("")
	expect(span.normalized).toStrictEqual("")
	expect(span.start).toStrictEqual(0)
	expect(span.end).toStrictEqual(0)
	expect(span.flags.has("numeric")).toBe(false)
	expect(span.flags.has("ends_with_period")).toBe(false)
})

test("setBody: update body", () => {
	const span = Span.from("Example")

	expect(span.body).toStrictEqual("Example")
	span.body = "Foo"
	expect(span.body).toStrictEqual("Foo")
})

test("setBody: update norm", () => {
	const span = Span.from("Example")

	expect(span.normalized).toStrictEqual("example")
	span.body = "Foo"
	expect(span.normalized).toStrictEqual("foo")
})

test("setBody: update end", () => {
	const span = Span.from("Example", { start: 10 })

	expect(span.start).toStrictEqual(10)
	expect(span.end).toStrictEqual(17)
	span.body = "Foo"
	expect(span.start).toStrictEqual(10)
	expect(span.end).toStrictEqual(13)
})

test("setBody: update contains.numerals", () => {
	const span = Span.from("Example")

	expect(span.flags.has("alpha")).toBe(true)
	expect(span.flags.has("numeral")).toBe(false)
	expect(span.flags.has("alphanumeric")).toBe(false)

	span.body = "foo1bar"
	expect(span.flags.has("alphanumeric")).toBe(true)
	expect(span.flags.has("numeral")).toBe(true)
})

test("setBody: update contains.final.period", () => {
	const span = Span.from("Example")

	expect(span.flags.has("ends_with_period")).toBe(false)
	span.body = "Foo."
	expect(span.flags.has("ends_with_period")).toBe(true)
})

test("setBody: trim text when greater than 140 characters with spaces", () => {
	const span =
		Span.from(`Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
      Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`)
	expect(span.start).toStrictEqual(0)
	expect(span.end).toStrictEqual(140)
})

test("setBody: do not trim text when it's 140 characters", () => {
	const span = Span.from(
		"LoremipsumdolorsitametconsecteturadipiscingelitseddoeiusmodtemporincididuntutlaboreetdoloremagnaaliquaUtenimadminimveniamquisnostrudexercita"
	)
	expect(span.start).toStrictEqual(0)
	expect(span.end).toStrictEqual(140)
})

test("intersects: basic", () => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")
	expect(spanA.intersects(spanB)).toBe(true)
	expect(spanB.intersects(spanA)).toBe(true)
})

test("intersects: advanced", () => {
	const spanA = Span.from("A")
	spanA.start = 0
	spanA.end = 1

	const spanB = Span.from("B")
	spanB.start = 1
	spanB.end = 2

	const spanC = Span.from("C")
	spanC.start = 0
	spanC.end = 2

	expect(spanA.intersects(spanB)).toBe(false)
	expect(spanB.intersects(spanA)).toBe(false)
	expect(spanA.intersects(spanC)).toBe(true)
	expect(spanC.intersects(spanA)).toBe(true)
	expect(spanB.intersects(spanC)).toBe(true)
	expect(spanC.intersects(spanB)).toBe(true)
})

test("covers: basic", () => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")
	expect(spanA.covers(spanB)).toBe(true)
	expect(spanB.covers(spanA)).toBe(true)
})

test("covers: advanced", () => {
	const spanA = Span.from("A")
	spanA.start = 0
	spanA.end = 10

	const spanB = Span.from("B")
	spanB.start = 2
	spanB.end = 10

	const spanC = Span.from("C")
	spanC.start = 0
	spanC.end = 5

	expect(spanA.covers(spanB)).toBe(true)
	expect(spanB.covers(spanA)).toBe(false)
	expect(spanA.covers(spanC)).toBe(true)
	expect(spanC.covers(spanA)).toBe(false)
	expect(spanB.covers(spanC)).toBe(false)
	expect(spanC.covers(spanB)).toBe(false)
})

test("distance: same", () => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")

	expect(spanA.distance(spanB)).toEqual(0)
	expect(spanB.distance(spanA)).toEqual(0)
})

test("distance: right", () => {
	const spanA = Span.from("A")
	const spanB = Span.from("B")
	spanB.start = 5
	spanB.end = 6

	expect(spanA.distance(spanB)).toEqual(4)
	expect(spanB.distance(spanA)).toEqual(4)
})

test("distance: left", () => {
	const spanA = Span.from("A")
	spanA.start = 2
	spanA.end = 3

	const spanB = Span.from("B")

	expect(spanA.distance(spanB)).toEqual(1)
	expect(spanB.distance(spanA)).toEqual(1)
})

test("connectSiblings - array list", () => {
	const spans = [Span.from("A"), Span.from("B"), Span.from("C")] as const
	Span.connectSiblings(...spans)

	expect(spans[0].nextSibling).toStrictEqual(spans[1])
	expect(spans[0].previousSibling).toBeFalsy()
	expect(spans[1].nextSibling).toStrictEqual(spans[2])
	expect(spans[1].previousSibling).toStrictEqual(spans[0])
	expect(spans[2].nextSibling).toBeFalsy()
	expect(spans[2].previousSibling).toStrictEqual(spans[1])
})

test("connectSiblings - list of items", () => {
	const a = Span.from("A")
	const b = Span.from("B")
	const c = Span.from("C")

	Span.connectSiblings(a, b, c)

	expect(a.nextSibling).toStrictEqual(b)
	expect(a.previousSibling).toBeFalsy()
	expect(b.nextSibling).toStrictEqual(c)
	expect(b.previousSibling).toStrictEqual(a)
	expect(c.nextSibling).toBeFalsy()
	expect(c.previousSibling).toStrictEqual(b)
})
