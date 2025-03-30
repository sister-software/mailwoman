// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { HouseNumberClassifier, HouseNumberFlag } from "./HouseNumberClassifier.js"

const classifier = new HouseNumberClassifier()

test("numeric: single digit", (t) => {
	const span = classifier.classify("1")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
	t.end()
})

test("numeric: two digits", (t) => {
	const span = classifier.classify("12")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
	t.end()
})

test("numeric: three digits", (t) => {
	const span = classifier.classify("123")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
	t.end()
})

test("numeric: four digits", (t) => {
	const span = classifier.classify("1234")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.9,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
	t.end()
})

test("numeric: five digits", (t) => {
	const span = classifier.classify("12345")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.2,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
	t.end()
})

test("numeric: six digits", (t) => {
	const span = classifier.classify("123456")
	t.equal(span.classifications.size, 0)
	t.end()
})

test("letter suffix: single digit", (t) => {
	const span = classifier.classify("1A")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
	t.end()
})

test("letter suffix: two digits", (t) => {
	const span = classifier.classify("12b")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
	t.end()
})

test("letter suffix: three digits", (t) => {
	const span = classifier.classify("123C")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
	t.end()
})

test("letter suffix: four digits", (t) => {
	const span = classifier.classify("1234d")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.9,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)

	t.end()
})

test("letter suffix: five digits", (t) => {
	const span = classifier.classify("12345E")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.2,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
	t.end()
})

test("letter suffix: six digits", (t) => {
	const span = classifier.classify("123456f")
	t.equal(span.classifications.size, 0, "should not classify")
	t.end()
})

test("letter suffix: Cyrillic Letter (в)", (t) => {
	const span = classifier.classify("15в")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "cyrillic"]),
		})
	)
	t.end()
})

test("Letter suffix: Cyrillic Homoglyph (б)", (t) => {
	// Note that this isn't the number 6, but the Cyrillic letter "б".
	const span = classifier.classify("15б")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "cyrillic"]),
		})
	)
	t.end()
})

test("hyphenated: 10-19", (t) => {
	const span = classifier.classify("10-19")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator"]),
		})
	)
	t.end()
})

test("hyphenated: 10-19a", (t) => {
	const span = classifier.classify("10-19a")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "alphanumeric"]),
		})
	)
	t.end()
})

test("hyphenated: 10-19B", (t) => {
	const span = classifier.classify("10-19B")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "alphanumeric"]),
		})
	)
	t.end()
})

test("forward slash: 1/135", (t) => {
	const span = classifier.classify("1/135")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "fractional", "numeric"]),
		})
	)
	t.end()
})

test("forward slash: 1a/135", (t) => {
	const span = classifier.classify("1a/135")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "fractional", "numeric"]),
		})
	)
	t.end()
})

test("forward slash: 1B/125", (t) => {
	const span = classifier.classify("1B/125")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "fractional", "numeric"]),
		})
	)
	t.end()
})

test("misc: 6N23", (t) => {
	const span = classifier.classify("6N23")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "directional"]),
		})
	)
	t.end()
})

test("misc: W350N5337", (t) => {
	const span = classifier.classify("W350N5337")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["directional", "numeric"]),
		})
	)
	t.end()
})

test("misc: N453", (t) => {
	const span = classifier.classify("N453")

	t.same(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["directional", "numeric"]),
		})
	)
	t.end()
})

test("Fraction: 1 3/4", (t) => {
	const span = classifier.classify("1 3/4")
	t.deepEqual(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "fractional"]),
		})
	)

	t.end()
})

test("Fraction: 25 2/2", (t) => {
	const span = classifier.classify("25 2/2")
	t.deepEqual(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "fractional"]),
		})
	)

	t.end()
})

test("Fraction: 11 1/3", (t) => {
	const span = classifier.classify("11 1/3")
	t.deepEqual(
		span.classifications,
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "fractional"]),
		})
	)

	t.end()
})

// test('misc: д. 1, кв. 1', (t) => {
//   let s = classify('д. 1, кв. 1')
//   t.deepEqual(span.classifications, { house_number: new housenumber() })
//   t.end()
// })
