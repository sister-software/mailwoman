/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { StreetPrefixClassifier } from "./StreetPrefixClassifier.js"

const classifier = await new StreetPrefixClassifier().ready()

test("index: does contain single char tokens", () => {
	const singleCharacterTokens = Iterator.from(classifier.index)
		.filter(([token]) => token.length < 2)
		.map(([token, languages]) => [token, Array.from(languages)])
		.toArray()

	expect(singleCharacterTokens, "StreetPrefixClassifier contain single character tokens").not.length(0)
})

const valid = ["rue", "allée", "allee", "avenue", "av", "rt.", "boulevard", "blvd", "blvd."]

valid.forEach((token) => {
	test(`French prefix: ${token}`, () => {
		const actual = classifier.classify(token).classifications.get("street_prefix")

		expect(actual, `"${token}" is classified as a street prefix`).toBeTruthy()

		expect(actual?.languages?.has("fr"), `"${token}" is classified as a french street prefix`).toBeTruthy()
	})
})
