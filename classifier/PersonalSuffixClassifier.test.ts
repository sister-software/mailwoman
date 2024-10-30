/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PersonalSuffixClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import PersonalSuffixClassifier from "./PersonalSuffixClassifier.js"

const classifier = new PersonalSuffixClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

const valid = ["junior", "jr", "senior", "sr"]

for (const token of valid) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			PersonalSuffixClassification: new PersonalSuffixClassification(1.0),
		})
		t.end()
	})
}
