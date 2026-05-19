/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { WhosOnFirstClassifier } from "./WhosOnFirstClassifier.js"

const classifier = await new WhosOnFirstClassifier().ready()

for (const token of ["new york", "london", "paris", "berlin", "bern", "tokyo"]) {
	test(`locality: ${token}`, () => {
		const span = classifier.classify(token)
		expect(span.is("locality")).toBe(true)
		expect(span.is("area")).toBe(true)
	})
}

for (const token of ["nyc", "sf"]) {
	test(`valid internal locality: ${token}`, () => {
		const span = classifier.classify(token)
		expect(span.is("locality")).toBe(true)
		expect(span.is("area")).toBe(true)
	})
}

const invalid = ["texas", "california", "italy"]

for (const token of invalid) {
	test(`invalid internal locality: ${token}`, () => {
		const span = classifier.classify(token)
		expect(span.is("locality")).toBe(false)
	})
}
