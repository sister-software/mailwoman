/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap, Span } from "@mailwoman/core"
import { expect, test } from "vitest"
import { UnitClassifier } from "./UnitClassifier.js"

const classifier = new UnitClassifier()

test("number without unit type", () => {
	const span = classifier.classify("2020")
	expect(span.classifications.size).toEqual(0)
})

test("letter without unit type", () => {
	const span = classifier.classify("alpha")
	expect(span.classifications.size).toEqual(0)
})

test("number and letter without unit type", () => {
	const span = classifier.classify("2020a")
	expect(span.classifications.size).toEqual(0)
})

test("letter and number without unit type", () => {
	const span = classifier.classify("a2")
	expect(span.classifications.size).toEqual(0)
})

test("single letter without unit type", () => {
	const span = classifier.classify("a")
	expect(span.classifications.size).toEqual(0)
})

test("number with # without unit type", () => {
	const span = classifier.classify("#22")
	expect(span.classifications.size).toEqual(0)
})

test("number with # without unit type with prev token", () => {
	const span = Span.from("#22")
	const previous = Span.from("prev")

	span.previousSiblings.add(previous)

	classifier.explore(span)
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("unit"))
})

test("number with unit type", () => {
	const span = classifier.classify("2020", "unit")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("unit"))
})

test("letters with unit type", () => {
	const span = classifier.classify("alpha", "unit")
	expect(span.classifications.size).toEqual(0)
})

test("number and letter with unit type", () => {
	const span = classifier.classify("2020a", "unit")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("unit"))
})

test("letter and number with unit type", () => {
	const span = classifier.classify("a2", "unit")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("unit"))
})

test("single letter with unit type", () => {
	const span = classifier.classify("a", "unit")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("unit"))
})

test("number with # with unit type", () => {
	const span = classifier.classify("#22", "unit")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("unit"))
})
