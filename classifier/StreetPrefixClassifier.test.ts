/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { StreetPrefixClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import StreetPrefixClassifier from "./StreetPrefixClassifier.js"

const classifier = new StreetPrefixClassifier()

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

const valid = ["rue", "allée", "allee", "avenue", "av", "rt.", "boulevard", "blvd", "blvd."]

valid.forEach((token) => {
	test(`french prefix: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			StreetPrefixClassification: new StreetPrefixClassification(token.length > 1 ? 1.0 : 0.2),
		})
		t.end()
	})
})
