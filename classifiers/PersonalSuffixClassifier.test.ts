// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { PersonalSuffixClassifier } from "./PersonalSuffixClassifier.js"

const classifier = await new PersonalSuffixClassifier().ready()

const valid = ["junior", "jr", "senior", "sr"]

for (const token of valid) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.same(span.classifications, ClassificationsMatchMap.from("personal_suffix"))

		t.end()
	})
}
