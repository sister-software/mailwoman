/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { MiddleInitialClassification } from "mailwoman/classification"
import test from "tape"
import MiddleInitialClassifier from "./MiddleInitialClassifier.js"

const classifier = new MiddleInitialClassifier()

for (const token of ["M.", "M"]) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			MiddleInitialClassification: new MiddleInitialClassification(1.0),
		})
		t.end()
	})
}

for (const token of ["Mae", "122", "M,", "&", "Mr", "Esq"]) {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {})
		t.end()
	})
}
