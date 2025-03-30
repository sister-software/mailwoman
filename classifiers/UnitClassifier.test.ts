// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap, Span } from "mailwoman/core"
import test from "tape"
import { UnitClassifier } from "./UnitClassifier.js"

const classifier = new UnitClassifier()

test("number without unit type", (t) => {
	const span = classifier.classify("2020")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("letter without unit type", (t) => {
	const span = classifier.classify("alpha")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("number and letter without unit type", (t) => {
	const span = classifier.classify("2020a")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("letter and number without unit type", (t) => {
	const span = classifier.classify("a2")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("single letter without unit type", (t) => {
	const span = classifier.classify("a")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("number with # without unit type", (t) => {
	const span = classifier.classify("#22")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("number with # without unit type with prev token", (t) => {
	const span = Span.from("#22")
	const previous = Span.from("prev")

	span.previousSiblings.add(previous)

	classifier.explore(span)
	t.same(span.classifications, ClassificationsMatchMap.from("unit"))
	t.end()
})

test("number with unit type", (t) => {
	const span = classifier.classify("2020", "unit")
	t.same(span.classifications, ClassificationsMatchMap.from("unit"))
	t.end()
})

test("letters with unit type", (t) => {
	const span = classifier.classify("alpha", "unit")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("number and letter with unit type", (t) => {
	const span = classifier.classify("2020a", "unit")
	t.same(span.classifications, ClassificationsMatchMap.from("unit"))
	t.end()
})

test("letter and number with unit type", (t) => {
	const span = classifier.classify("a2", "unit")
	t.same(span.classifications, ClassificationsMatchMap.from("unit"))
	t.end()
})

test("single letter with unit type", (t) => {
	const span = classifier.classify("a", "unit")
	t.same(span.classifications, ClassificationsMatchMap.from("unit"))
	t.end()
})

test("number with # with unit type", (t) => {
	const span = classifier.classify("#22", "unit")
	t.same(span.classifications, ClassificationsMatchMap.from("unit"))
	t.end()
})
