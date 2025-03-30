// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"
import test from "tape"
import { ToponymClassifier } from "./ToponymClassifier.js"

const classifier = await new ToponymClassifier().ready()

test("index: does not contain single char tokens", (t) => {
	const singleCharacterTokens = Iterator.from(classifier.index)
		.filter(([token]) => token.length < 2)
		.map(([token, languages]) => [token, Array.from(languages)])
		.toArray()

	t.deepEqual(singleCharacterTokens, [], "ToponymClassifier contain single character tokens")
	t.end()
})

assertClassification(classifier, "toponym", [
	["md", ["en"]],
	["maryland", ["en"]],
	["ca", ["en"]],
	["california", ["en"]],
	["ia", ["en"]],
	["nj", ["en"]],
])
