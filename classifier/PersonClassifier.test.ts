/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PersonClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import PersonClassifier from "./PersonClassifier.js"
const classifier = new PersonClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

const valid = [
	"Martin Luther King",
	"m l k",
	"MLK",
	"John Fitzgerald Kennedy",
	"j f k",
	"JFK",
	"cdg",
	"Charles De Gaulle",
]

valid.forEach((token) => {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			PersonClassification: new PersonClassification(1.0),
		})
		t.end()
	})
})
