/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { OrdinalClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import OrdinalClassifier from "./OrdinalClassifier.js"

const classifier = new OrdinalClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("100")
	span.contains.numerals = false
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

test("English: single digit", (t) => {
	const span = classifier.classify("1st")
	t.deepEqual(span.classifications, { OrdinalClassification: new OrdinalClassification(1.0) })
	t.end()
})

test("English: multiple digits", (t) => {
	const span = classifier.classify("250th")
	t.deepEqual(span.classifications, { OrdinalClassification: new OrdinalClassification(1.0) })
	t.end()
})

test("English: single digit", (t) => {
	const span = classifier.classify("1rd")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("English: multiple digits", (t) => {
	const span = classifier.classify("250nd")
	t.deepEqual(span.classifications, {})
	t.end()
})
