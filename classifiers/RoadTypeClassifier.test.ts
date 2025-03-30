// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { RoadTypeClassifier } from "./RoadTypeClassifier.js"

const classifier = await new RoadTypeClassifier().ready()

test("index: does contain single char tokens", (t) => {
	const singleCharacterTokens = Iterator.from(classifier.index)
		.filter(([token]) => token.length < 2)
		.map(([token, languages]) => [token, Array.from(languages)])
		.toArray()

	t.notDeepEqual(singleCharacterTokens, [], "RoadTypeClassifier contain single character tokens")
	t.end()
})

const valid = ["highway", "road", "hi", "route", "hway", "r"]

valid.forEach((token) => {
	test(`french prefix: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.same(
			span.classifications,
			ClassificationsMatchMap.from({
				classification: "road_type",
				confidence: token.length > 1 ? 1 : 0.2,
			}),
			"French road types are classified correctly"
		)

		t.end()
	})
})
