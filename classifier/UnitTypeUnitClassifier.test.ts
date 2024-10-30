/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitClassification, UnitTypeClassification } from "mailwoman/classification"
import test from "tape"
import { UnitTypeUnitClassifier } from "./UnitTypeUnitClassifier.js"
const classifier = new UnitTypeUnitClassifier()

const valid = ["unit16", "apt23", "lot75"]

const invalid = ["unit", "23", "Main"]

valid.forEach((token) => {
	test(`english unit types: ${token}`, (t) => {
		const span = classifier.classify(token)

		const classifications = span.graph
			.findAll("child")
			.map((s) => s.classifications)
			.filter((c) => c)

		t.equal(span.graph.findAll("child").length, 2)
		t.deepEqual(
			classifications.find((c) => c.UnitTypeClassification),
			{
				UnitTypeClassification: new UnitTypeClassification(1, {}),
			}
		)
		t.deepEqual(
			classifications.find((c) => c.UnitClassification),
			{
				UnitClassification: new UnitClassification(1, {}),
			}
		)
		t.end()
	})
})

invalid.forEach((token) => {
	test(`english unit types: ${token}`, (t) => {
		const span = classifier.classify(token)

		t.equal(span.graph.findAll("child").length, 0)
		t.end()
	})
})
