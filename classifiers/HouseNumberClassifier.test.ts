/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap } from "@mailwoman/core"
import { expect, test } from "vitest"

import { HouseNumberClassifier, HouseNumberFlag } from "./HouseNumberClassifier.ts"

const classifier = new HouseNumberClassifier()

test("numeric: single digit", () => {
	const span = classifier.classify("1")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
})

test("numeric: two digits", () => {
	const span = classifier.classify("12")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
})

test("numeric: three digits", () => {
	const span = classifier.classify("123")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
})

test("numeric: four digits", () => {
	const span = classifier.classify("1234")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.9,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
})

test("numeric: five digits", () => {
	const span = classifier.classify("12345")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.2,
			flags: new Set<HouseNumberFlag>(["numeric"]),
		})
	)
})

test("numeric: six digits", () => {
	const span = classifier.classify("123456")

	expect(span.classifications.size).toEqual(0)
})

test("letter suffix: single digit", () => {
	const span = classifier.classify("1A")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
})

test("letter suffix: two digits", () => {
	const span = classifier.classify("12b")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
})

test("letter suffix: three digits", () => {
	const span = classifier.classify("123C")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
})

test("letter suffix: four digits", () => {
	const span = classifier.classify("1234d")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.9,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
})

test("letter suffix: five digits", () => {
	const span = classifier.classify("12345E")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 0.2,
			flags: new Set<HouseNumberFlag>(["alphanumeric"]),
		})
	)
})

test("letter suffix: six digits", () => {
	const span = classifier.classify("123456f")
	expect(span.classifications.size, "should not classify").toEqual(0)
})

test("letter suffix: Cyrillic Letter (в)", () => {
	const span = classifier.classify("15в")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "cyrillic"]),
		})
	)
})

test("Letter suffix: Cyrillic Homoglyph (б)", () => {
	// Note that this isn't the number 6, but the Cyrillic letter "б".
	const span = classifier.classify("15б")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "cyrillic"]),
		})
	)
})

test("hyphenated: 10-19", () => {
	const span = classifier.classify("10-19")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator"]),
		})
	)
})

test("hyphenated: 10-19a", () => {
	const span = classifier.classify("10-19a")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "alphanumeric"]),
		})
	)
})

test("hyphenated: 10-19B", () => {
	const span = classifier.classify("10-19B")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "alphanumeric"]),
		})
	)
})

test("forward slash: 1/135", () => {
	const span = classifier.classify("1/135")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "fractional", "numeric"]),
		})
	)
})

test("forward slash: 1a/135", () => {
	const span = classifier.classify("1a/135")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "fractional", "numeric"]),
		})
	)
})

test("forward slash: 1B/125", () => {
	const span = classifier.classify("1B/125")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["alphanumeric", "fractional", "numeric"]),
		})
	)
})

test("misc: 6N23", () => {
	const span = classifier.classify("6N23")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "directional"]),
		})
	)
})

test("misc: W350N5337", () => {
	const span = classifier.classify("W350N5337")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["directional", "numeric"]),
		})
	)
})

test("misc: N453", () => {
	const span = classifier.classify("N453")

	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["directional", "numeric"]),
		})
	)
})

test("Fraction: 1 3/4", () => {
	const span = classifier.classify("1 3/4")
	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "fractional"]),
		})
	)
})

test("Fraction: 25 2/2", () => {
	const span = classifier.classify("25 2/2")
	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "fractional"]),
		})
	)
})

test("Fraction: 11 1/3", () => {
	const span = classifier.classify("11 1/3")
	expect(span.classifications).toStrictEqual(
		ClassificationsMatchMap.from({
			classification: "house_number",
			confidence: 1,
			flags: new Set<HouseNumberFlag>(["numeric", "separator", "fractional"]),
		})
	)
})
