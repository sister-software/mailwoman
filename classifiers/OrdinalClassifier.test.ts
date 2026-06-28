/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap } from "@mailwoman/core"
import { expect, test } from "vitest"

import { OrdinalClassifier } from "./OrdinalClassifier.js"

const classifier = new OrdinalClassifier()

test("English: single digit", () => {
	const span = classifier.classify("1st")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("ordinal"))
})

test("English: multiple digits", () => {
	const span = classifier.classify("250th")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("ordinal"))
})

test("English: single digit", () => {
	const span = classifier.classify("1rd")
	expect(span.classifications.size).toEqual(0)
})

test("English: multiple digits", () => {
	const span = classifier.classify("250nd")
	expect(span.classifications.size).toEqual(0)
})
