// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import test from "tape"
import { StreetSuffixClassifier } from "./StreetSuffixClassifier.js"

const classifier = await new StreetSuffixClassifier().ready()

test("index: does not contain single char tokens", (t) => {
	const singleCharacterTokens = Iterator.from(classifier.index)
		.filter(([token]) => token.length < 2)
		.map(([token, languages]) => [token, Array.from(languages)])
		.toArray()

	t.deepEqual(singleCharacterTokens, [], "StreetSuffixClassifier contain single character tokens")
	t.end()
})

for (const token of ["street", "st", "st.", "road", "rd", "rd.", "boulevard", "blvd", "blvd."]) {
	test(`english suffix: ${token}`, (t) => {
		const span = classifier.classify(token)

		const match = span.classifications.get("street_suffix")

		t.ok(match, `"${token}" is classified as a street suffix`)

		t.equal(match?.confidence, token.length > 1 ? 1 : 0.2, `"${token}" confidence is correct`)

		t.end()
	})
}

for (const token of ["straße", "strasse", "str", "str.", "platz", "pl.", "allee", "al", "al.", "weg", "w."]) {
	test(`german suffix: ${token}`, (t) => {
		const span = classifier.classify(token)
		const match = span.classifications.get("street_suffix")

		t.ok(match, `"${token}" is classified as a street suffix`)

		t.equal(match?.confidence, token.length > 1 ? 1 : 0.2, `"${token}" confidence is correct`)

		t.end()
	})
}

for (const token of ["paku"]) {
	test(`valid internal street types: ${token}`, (t) => {
		const span = classifier.classify("paku")
		const match = span.classifications.get("street_suffix")

		t.ok(match, `"${token}" is classified as a street suffix`)

		t.equal(match?.confidence, token.length > 1 ? 1 : 0.2, `"${token}" confidence is correct`)

		t.end()
	})
}

for (const token of ["and"]) {
	test(`invalid internal street types: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.equals(span.classifications.size, 0)

		t.end()
	})
}
