/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { RoadTypeClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import RoadTypeClassifier from "./RoadTypeClassifier.js"

const classifier = new RoadTypeClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

test("index: does contain single char tokens", (t) => {
	t.true(Object.keys(classifier.index).some((token) => token.length < 2))
	t.end()
})

const valid = ["highway", "road", "hi", "route", "hway", "r"]

valid.forEach((token) => {
	test(`french prefix: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			RoadTypeClassification: new RoadTypeClassification(token.length > 1 ? 1.0 : 0.2),
		})
		t.end()
	})
})
