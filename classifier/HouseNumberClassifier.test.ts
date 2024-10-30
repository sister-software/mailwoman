/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { HouseNumberClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import HouseNumberClassifier from "./HouseNumberClassifier.js"

const classifier = new HouseNumberClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("100")
	span.contains.numerals = false
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

test("numeric: single digit", (t) => {
	const span = classifier.classify("1")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("numeric: two digits", (t) => {
	const span = classifier.classify("12")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("numeric: three digits", (t) => {
	const span = classifier.classify("123")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("numeric: four digits", (t) => {
	const span = classifier.classify("1234")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(0.9) })
	t.end()
})

test("numeric: five digits", (t) => {
	const span = classifier.classify("12345")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(0.2) })
	t.end()
})

test("numeric: six digits", (t) => {
	const span = classifier.classify("123456")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("letter suffix: single digit", (t) => {
	const span = classifier.classify("1A")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("letter suffix: two digits", (t) => {
	const span = classifier.classify("12b")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("letter suffix: three digits", (t) => {
	const span = classifier.classify("123C")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("letter suffix: four digits", (t) => {
	const span = classifier.classify("1234d")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(0.9) })
	t.end()
})

test("letter suffix: five digits", (t) => {
	const span = classifier.classify("12345E")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(0.2) })
	t.end()
})

test("letter suffix: six digits", (t) => {
	const span = classifier.classify("123456f")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("letter suffix: Cyrillic", (t) => {
	const span = classifier.classify("15в")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("letter suffix: Cyrillic", (t) => {
	const span = classifier.classify("15б")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("hyphenated: 10-19", (t) => {
	const span = classifier.classify("10-19")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("hyphenated: 10-19a", (t) => {
	const span = classifier.classify("10-19a")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("hyphenated: 10-19B", (t) => {
	const span = classifier.classify("10-19B")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("forward slash: 1/135", (t) => {
	const span = classifier.classify("1/135")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("forward slash: 1a/135", (t) => {
	const span = classifier.classify("1a/135")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("forward slash: 1B/125", (t) => {
	const span = classifier.classify("1B/125")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("misc: 6N23", (t) => {
	const span = classifier.classify("6N23")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("misc: W350N5337", (t) => {
	const span = classifier.classify("W350N5337")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

test("misc: N453", (t) => {
	const span = classifier.classify("N453")
	t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
	t.end()
})

// test('misc: д. 1, кв. 1', (t) => {
//   let s = classify('д. 1, кв. 1')
//   t.deepEqual(span.classifications, { HouseNumberClassification: new HouseNumberClassification(1.0) })
//   t.end()
// })
