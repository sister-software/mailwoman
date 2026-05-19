// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "@mailwoman/core"
import { expect, test } from "vitest"
import { RoadTypeClassifier } from "./RoadTypeClassifier.js"

const classifier = await new RoadTypeClassifier().ready()

test("index: does contain single char tokens", () => {
	const singleCharacterTokens = Iterator.from(classifier.index)
		.filter(([token]) => token.length < 2)
		.map(([token, languages]) => [token, Array.from(languages)])
		.toArray()

	expect(singleCharacterTokens, "RoadTypeClassifier contain single character tokens").not.length(0)
})

const valid = ["highway", "road", "hi", "route", "hway", "r"]

valid.forEach((token) => {
	test(`french prefix: ${token}`, () => {
		const span = classifier.classify(token)

		expect(span.classifications, "French road types are classified correctly").toEqual(
			ClassificationsMatchMap.from({
				classification: "road_type",
				confidence: token.length > 1 ? 1 : 0.2,
			})
		)
	})
})
