/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, pluckLanguageLabel } from "@mailwoman/core"
import { expect, test } from "vitest"
import { StreetSuffixClassifier } from "./StreetSuffixClassifier.js"

const classifier = await new StreetSuffixClassifier().ready()

test("index: does not contain single char tokens", () => {
	const singleCharacterTokens = Iterator.from(classifier.index)
		.filter(([token]) => token.length < 2)
		.map(([token, languages]) => [token, Array.from(languages)])
		.toArray()

	expect(singleCharacterTokens, "StreetSuffixClassifier contain single character tokens").toEqual([])
})

const positiveTestCases = new Map<string, string[]>([
	[
		// ---
		Alpha2LanguageCode.English,
		["street", "st", "st.", "road", "rd", "rd.", "boulevard", "blvd", "blvd."],
	],
	[
		// ---
		Alpha2LanguageCode.German,
		["straße", "strasse", "str", "str.", "platz", "pl.", "allee", "al", "al.", "weg", "w."],
	],
	["internal", ["paku"]],
])

for (const [language, tokens] of positiveTestCases) {
	const label = pluckLanguageLabel(language)

	test(`valid street types: ${label}`, () => {
		for (const token of tokens) {
			const span = classifier.classify(token)

			const match = span.classifications.get("street_suffix")

			expect(match, `"${token}" is classified as a street suffix`).toBeTruthy()
			expect(match?.confidence, `"${token}" confidence is correct`).toEqual(token.length > 1 ? 1 : 0.2)
		}
	})
}

const negativeTestCases = new Map<string, string[]>([
	[Alpha2LanguageCode.English, ["and", "or", "the", "a", "an", "are"]],
])

for (const [language, tokens] of negativeTestCases) {
	const label = pluckLanguageLabel(language)

	test(`valid street types: ${label}`, () => {
		for (const token of tokens) {
			const span = classifier.classify(token)

			if (span.classifications.size > 0) {
				for (const match of span.classifications.values()) {
					const languages = Array.from(match.languages ?? [], (l) => pluckLanguageLabel(l))
					expect(
						match.classification,
						`"${token}" is classified as a street suffix (${languages.join(", ")}), but should not be`
					).toBeFalsy()
				}
			} else {
				expect(span.classifications.size, `"${token}" is not classified as a street suffix in ${label}`).toEqual(0)
			}
		}
	})
}
