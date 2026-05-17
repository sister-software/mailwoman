/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap, Span } from "@mailwoman/core"
import { expect, test } from "vitest"
import { CentralEuropeanStreetNameClassifier } from "./CentralEuropeanStreetNameClassifier.js"

const classifier = new CentralEuropeanStreetNameClassifier()

const foo = Span.from("Foo")
const fooHouseNum = Span.from("1", {
	start: 4,
	classifications: ["house_number"],
})

foo.nextSiblings.add(fooHouseNum)

const bar = Span.from("Bar")
const barHouseNum = Span.from("2137", {
	start: 4,
	classifications: ["house_number"],
})
bar.nextSiblings.add(barHouseNum)

const baz = Span.from("Baz")
const bazHouseNum0 = Span.from("152/160", {
	start: 4,
	classifications: ["house_number"],
})
const bazHouseNum1 = Span.from("152", {
	start: 4,
	classifications: ["house_number"],
})
const bazHouseNum2 = Span.from("160", {
	start: 8,
	classifications: ["house_number"],
})

baz.nextSiblings.add(bazHouseNum0, bazHouseNum1)

bazHouseNum1.nextSiblings.add(bazHouseNum2)

// The Qux test case covers when the section has a greater length than
// the tokens it contains, such as when it ends with whitespace.
const qux = Span.from("Qux")
const quxHouseNum = Span.from("1", {
	start: 4,
	classifications: ["house_number"],
})
qux.nextSiblings.add(quxHouseNum)

const valid = [
	Span.from("Foo 1", { children: [foo, fooHouseNum] }),
	Span.from("Bar 2137", { children: [bar, barHouseNum] }),
	Span.from("Baz 152/160", { children: [baz, bazHouseNum0, bazHouseNum1, bazHouseNum2] }),
	Span.from("Qux 1 ", { children: [qux, quxHouseNum] }),
]

valid.forEach((span) => {
	test(`classify: ${span.body}`, () => {
		classifier.explore(span)

		const [head, ...tail] = span.children

		// first child should now be classified as a street
		expect(head!.classifications, `'${span.body}'`).toStrictEqual(
			ClassificationsMatchMap.from({
				classification: "street",
				confidence: 0.5,
				flags: new Set(["central_european_street_name"]),
			})
		)

		tail.forEach((c) => {
			expect(c.classifications, `'${span.body}'`).toStrictEqual(
				ClassificationsMatchMap.from({
					classification: "house_number",
					confidence: 1,
				})
			)
		})
	})
})
