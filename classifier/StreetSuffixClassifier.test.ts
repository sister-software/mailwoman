/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { StreetSuffixClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import StreetSuffixClassifier from "./StreetSuffixClassifier.js"

const classifier = new StreetSuffixClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

test("index: does not contain single char tokens", (t) => {
	t.false(Object.keys(classifier.index).some((token) => token.length < 2))
	t.end()
})

for (const token of ["street", "st", "st.", "road", "rd", "rd.", "boulevard", "blvd", "blvd."]) {
	test(`english suffix: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			StreetSuffixClassification: new StreetSuffixClassification(token.length > 1 ? 1.0 : 0.2),
		})
		t.end()
	})
}

// for (const token of ["straße", "strasse", "str", "str.", "platz", "pl.", "allee", "al", "al.", "weg", "w."]) {
// 	test(`german suffix: ${token}`, (t) => {
// 		const span = classifier.classify(token)
// 		t.deepEqual(span.classifications, {
// 			StreetSuffixClassification: new StreetSuffixClassification(token.length > 1 ? 1.0 : 0.2),
// 		})
// 		t.end()
// 	})
// }

// for (const token of ["paku"]) {
// 	test(`valid pelias street types: ${token}`, (t) => {
// 		const span = classifier.classify(token)
// 		t.deepEqual(span.classifications, {
// 			StreetSuffixClassification: new StreetSuffixClassification(token.length > 1 ? 1.0 : 0.2),
// 		})
// 		t.end()
// 	})
// }

// for (const token of ["and"]) {
// 	test(`invalid pelias street types: ${token}`, (t) => {
// 		const span = classifier.classify(token)
// 		t.deepEqual(span.classifications, {})
// 		t.end()
// 	})
// }
