// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { LevelDesignatorClassifier } from "./LevelDesignatorClassifier.js"

const classifier = await new LevelDesignatorClassifier().ready()

for (const token of ["fl", "floor"]) {
	test(`english level types: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.same(span.classifications, ClassificationsMatchMap.from("level_designator"))

		t.end()
	})
}
