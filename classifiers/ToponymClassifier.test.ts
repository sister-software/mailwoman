/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertClassification } from "mailwoman/sdk/test"
import { expect, test } from "vitest"
import { ToponymClassifier } from "./ToponymClassifier.js"

const classifier = await new ToponymClassifier().ready()

test("index: does not contain single char tokens", () => {
	const singleCharacterTokens = Iterator.from(classifier.index)
		.filter(([token]) => token.length < 2)
		.map(([token, languages]) => [token, Array.from(languages)])
		.toArray()

	expect(singleCharacterTokens, "ToponymClassifier contain no single character tokens").toEqual([])
})

assertClassification(classifier, "toponym", [
	["md", ["en"]],
	["maryland", ["en"]],
	["ca", ["en"]],
	["california", ["en"]],
	["ia", ["en"]],
	["nj", ["en"]],
])
