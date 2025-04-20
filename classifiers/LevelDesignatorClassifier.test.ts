// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import { expect, test } from "vitest"
import { LevelDesignatorClassifier } from "./LevelDesignatorClassifier.js"

const classifier = await new LevelDesignatorClassifier().ready()

for (const token of ["fl", "floor"]) {
	test(`english level types: ${token}`, () => {
		const span = classifier.classify(token)

		expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("level_designator"))
	})
}
