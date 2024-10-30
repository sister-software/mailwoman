/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SurnameClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import SurnameClassifier from "./SurnameClassifier.js"

const classifier = new SurnameClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

for (const token of ["Van der Beugel", "Johnson"]) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			SurnameClassification: new SurnameClassification(1.0),
		})
		t.end()
	})
}
