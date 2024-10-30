/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { StreetProperNameClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import StreetProperNameClassifier from "./StreetProperNameClassifier.js"

const classifier = new StreetProperNameClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

for (const token of ["broadway", "esplanade"]) {
	test(`street_proper_names: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			StreetProperNameClassification: new StreetProperNameClassification(0.7),
		})
		t.end()
	})
}
