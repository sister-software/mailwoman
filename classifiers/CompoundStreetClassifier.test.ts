// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { CompoundStreetClassifier } from "./CompoundStreetClassifier.js"

const classifier = await new CompoundStreetClassifier().ready()

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

for (const token of valid) {
	test(`german compound: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.same(
			span.classifications,
			ClassificationsMatchMap.from({
				classification: "street",
				confidence: token.length > 1 ? 1 : 0.2,
			})
		)

		t.end()
	})
}

const invalid = ["testal", "testw", "testw."]

invalid.forEach((token) => {
	test(`german compound: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.equal(span.classifications.size, 0)
		t.end()
	})
})
