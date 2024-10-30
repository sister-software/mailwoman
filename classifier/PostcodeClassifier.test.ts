/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PostcodeClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import PostcodeClassifier from "./PostcodeClassifier.js"

const classifier = new PostcodeClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("100")
	span.contains.numerals = false
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

test("classify: USA ZIP", (t) => {
	const span = classifier.classify("10010")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: USA ZIP Plus 4", (t) => {
	const span = classifier.classify("99577-0727")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: DEU", (t) => {
	const span = classifier.classify("10117")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: NZD", (t) => {
	const span = classifier.classify("6012")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: AUD", (t) => {
	const span = classifier.classify("2000")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: FRA", (t) => {
	const span = classifier.classify("75000")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: GBP", (t) => {
	const span = classifier.classify("E81DN")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: JAP", (t) => {
	const span = classifier.classify("100-0000")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: RUS", (t) => {
	const span = classifier.classify("101000")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: BRA", (t) => {
	const span = classifier.classify("18180-000")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})

test("classify: NLD", (t) => {
	const span = classifier.classify("7512EC")
	t.deepEqual(span.classifications, { PostcodeClassification: new PostcodeClassification(1.0) })
	t.end()
})
