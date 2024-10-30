/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { StopWordClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import StopWordClassifier from "./StopWordClassifier.js"

const classifier = new StopWordClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

const valid = ["de", "la", "l'", "du", "à", "sur"]

valid.forEach((token) => {
	test(`french stop_words: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			StopWordClassification: new StopWordClassification(token.length > 1 ? 0.75 : 0.2),
		})
		t.end()
	})
})
