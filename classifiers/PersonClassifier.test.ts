// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { PersonClassifier } from "./PersonClassifier.js"
const classifier = await new PersonClassifier().ready()

const valid = [
	"Martin Luther King",
	"m l k",
	"MLK",
	"John Fitzgerald Kennedy",
	"j f k",
	"JFK",
	"cdg",
	"Charles De Gaulle",
]

valid.forEach((token) => {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.same(span.classifications, ClassificationsMatchMap.from("person"))

		t.end()
	})
})
