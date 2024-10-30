/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import WhosOnFirstClassifier from "./WhosOnFirstClassifier.js"

const classifier = new WhosOnFirstClassifier()

for (const token of ["new york", "london", "paris", "berlin", "bern", "tokyo"]) {
	test(`locality: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.true(span.classifications.hasOwnProperty("LocalityClassification"))
		t.true(span.classifications.hasOwnProperty("AreaClassification"))
		t.end()
	})
}

for (const token of ["nyc", "sf"]) {
	test(`valid pelias locality: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.true(span.classifications.hasOwnProperty("LocalityClassification"))
		t.true(span.classifications.hasOwnProperty("AreaClassification"))
		t.end()
	})
}

const invalid = ["texas", "california", "italy"]

for (const token of invalid) {
	test(`invalid pelias locality: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.false(span.classifications.hasOwnProperty("LocalityClassification"))
		t.end()
	})
}
