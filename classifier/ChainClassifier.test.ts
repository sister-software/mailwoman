/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ChainClassification } from "mailwoman/classification"
import test from "tape"
import ChainClassifier from "./ChainClassifier.js"

const classifier = new ChainClassifier()

const valid = ["McDonalds", "McDonald's", "lone star steakhouse", "panda express"]

valid.forEach((token) => {
	test(`classify: ${token}`, (t) => {
		const span = classifier.classify(token)
		t.deepEqual(span.classifications, {
			ChainClassification: new ChainClassification(1.0),
		})
		t.end()
	})
})
