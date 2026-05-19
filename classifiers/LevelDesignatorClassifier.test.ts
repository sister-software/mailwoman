/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap } from "@mailwoman/core"
import { expect, test } from "vitest"
import { LevelDesignatorClassifier } from "./LevelDesignatorClassifier.js"

const classifier = await new LevelDesignatorClassifier().ready()

for (const token of ["fl", "floor"]) {
	test(`english level types: ${token}`, () => {
		const span = classifier.classify(token)

		expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("level_designator"))
	})
}
