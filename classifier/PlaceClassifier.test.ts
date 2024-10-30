/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PlaceClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import PlaceClassifier from "./PlaceClassifier.js"

const classifier = new PlaceClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

const valid = ["stables", "swimming pool", "cafe", "bar"]

valid.forEach((token) => {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			PlaceClassification: new PlaceClassification(1.0),
		})
		t.end()
	})
})
