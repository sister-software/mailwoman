/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ToponymClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import ToponymClassifier from "./ToponymClassifier.js"

const classifier = new ToponymClassifier()

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

for (const token of ["md", "maryland", "ca", "california", "ia", "nj"]) {
	test(`english toponyms: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.deepEqual(span.classifications, {
			ToponymClassification: new ToponymClassification(1, { langs: { en: true } }),
		})
		t.end()
	})
}
