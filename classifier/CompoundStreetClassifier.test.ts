/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { StreetClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import CompoundStreetClassifier from "./CompoundStreetClassifier.js"

const classifier = new CompoundStreetClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)

	t.deepEqual(span.classifications, {})
	t.end()
})

const valid = [
	"teststraße",
	"teststrasse",
	"teststr.",
	"teststr",
	"grolmanstr",
	"testallee",
	"testweg",
	"testplatz",
	"testpl.",
	"testvägen",
]

console.log(">>>", classifier.suffixes)

for (const token of valid) {
	test(`german compound: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.deepEqual(span.classifications, {
			StreetClassification: new StreetClassification(token.length > 1 ? 1.0 : 0.2),
		})
		t.end()
	})
}

const invalid = ["testal", "testw", "testw."]

invalid.forEach((token) => {
	test(`german compound: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {})
		t.end()
	})
})
