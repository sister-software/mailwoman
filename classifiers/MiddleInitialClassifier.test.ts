// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { MiddleInitialClassifier } from "./MiddleInitialClassifier.js"

const classifier = new MiddleInitialClassifier()

for (const token of ["M.", "M"]) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.same(span.classifications, ClassificationsMatchMap.from("middle_initial"))

		t.end()
	})
}

for (const token of ["Mae", "122", "M,", "&", "Mr", "Esq"]) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.equal(span.classifications.size, 0)
		t.end()
	})
}
