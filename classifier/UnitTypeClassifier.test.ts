/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitTypeClassification } from "mailwoman/classification"
import test from "tape"
import { UnitTypeClassifier } from "./UnitTypeClassifier.js"

const classifier = new UnitTypeClassifier()

for (const token of ["unit", "apt", "lot"]) {
	test(`english unit types: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.deepEqual(span.classifications, {
			UnitTypeClassification: new UnitTypeClassification(1, {}),
		})
		t.end()
	})
}
