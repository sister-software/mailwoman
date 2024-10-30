/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { LevelTypeClassification } from "mailwoman/classification"
import test from "tape"
import { LevelTypeClassifier } from "./LevelTypeClassifier.js"

const classifier = new LevelTypeClassifier()

for (const token of ["fl", "floor"]) {
	test(`english level types: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.deepEqual(span.classifications, {
			LevelTypeClassification: new LevelTypeClassification(1, {}),
		})
		t.end()
	})
}
