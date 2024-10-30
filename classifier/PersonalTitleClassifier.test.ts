/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PersonalTitleClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import PersonalTitleClassifier from "./PersonalTitleClassifier.js"

const classifier = new PersonalTitleClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

const valid = ["Général", "General", "gal", "Saint", "st", "cdt", "l'Amiral", "Burgemeester"]

for (const token of valid) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			PersonalTitleClassification: new PersonalTitleClassification(1.0),
		})
		t.end()
	})
}
