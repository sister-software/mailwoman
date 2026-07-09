/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ClassificationMatch } from "@mailwoman/core/classification"
import { Span } from "@mailwoman/core/tokenization"
import { expect, test } from "vitest"

import { calculateRangeScore, compareMatchesByStart, SolutionMatch } from "./SolutionMatch.ts"

//#region Construction from a bare Classification string

test("SolutionMatch: a string classification yields confidence 1", () => {
	const match = new SolutionMatch(new Span("Vermont", 4), "locality")

	expect(match.classification).toBe("locality")
	expect(match.confidence).toBe(1)
})

test("SolutionMatch: value/start/end mirror the underlying span", () => {
	const span = new Span("Vermont", 4)
	const match = new SolutionMatch(span, "locality")

	expect(match.value).toBe("Vermont")
	expect(match.start).toBe(4)
	expect(match.end).toBe(11) // start 4 + length 7
	expect(match.span).toBe(span)
})

//#endregion

//#region Construction from a ClassificationMatch object

test("SolutionMatch: a ClassificationMatch object preserves its classification + confidence", () => {
	const input: ClassificationMatch = { classification: "region", confidence: 0.42 }
	const match = new SolutionMatch(new Span("VT"), input)

	expect(match.classification).toBe("region")
	expect(match.confidence).toBe(0.42)
})

test("SolutionMatch: confidence 0 from a match object is preserved (not coerced to 1)", () => {
	const match = new SolutionMatch(new Span("VT"), { classification: "region", confidence: 0 })

	expect(match.confidence).toBe(0)
})

//#endregion

//#region coverage / languages accessors

test("SolutionMatch.coverage: a leaf span covers its character length", () => {
	const match = new SolutionMatch(new Span("Vermont"), "locality")

	expect(match.coverage).toBe(7)
})

test("SolutionMatch.coverage: a parent span sums its children's ranges", () => {
	const parent = new Span("123 Main")
	parent.children.add(new Span("123", 0), new Span("Main", 4))
	const match = new SolutionMatch(parent, "street")

	// children "123" (0..3) + "Main" (4..8) = 3 + 4 = 7
	expect(match.coverage).toBe(7)
})

//#endregion

//#region toJSON serialization

test("SolutionMatch.toJSON: serializes classification, confidence, value, start, end", () => {
	const match = new SolutionMatch(new Span("Vermont", 4), { classification: "locality", confidence: 0.9 })

	expect(match.toJSON()).toEqual({
		classification: "locality",
		confidence: 0.9,
		value: "Vermont",
		start: 4,
		end: 11,
	})
})

test("SolutionMatch.toJSON: a string-constructed match serializes with confidence 1", () => {
	const match = new SolutionMatch(new Span("90210", 10), "postcode")

	expect(match.toJSON()).toEqual({
		classification: "postcode",
		confidence: 1,
		value: "90210",
		start: 10,
		end: 15,
	})
})

//#endregion

//#region compareMatchesByStart

test("compareMatchesByStart: orders by ascending span start index", () => {
	const later = new SolutionMatch(new Span("b", 10), "locality")
	const earlier = new SolutionMatch(new Span("a", 2), "house_number")

	expect(compareMatchesByStart(earlier, later)).toBeLessThan(0)
	expect(compareMatchesByStart(later, earlier)).toBeGreaterThan(0)
})

test("compareMatchesByStart: equal starts compare as 0 (stable)", () => {
	const a = new SolutionMatch(new Span("a", 5), "locality")
	const b = new SolutionMatch(new Span("b", 5), "region")

	expect(compareMatchesByStart(a, b)).toBe(0)
})

test("compareMatchesByStart: usable as an Array.sort comparator", () => {
	const matches = [
		new SolutionMatch(new Span("c", 20), "locality"),
		new SolutionMatch(new Span("a", 0), "house_number"),
		new SolutionMatch(new Span("b", 10), "street"),
	]

	const sorted = [...matches].sort(compareMatchesByStart).map((m) => m.start)

	expect(sorted).toEqual([0, 10, 20])
})

//#endregion

//#region calculateRangeScore

test("calculateRangeScore: a leaf span's range is its character span", () => {
	const match = new SolutionMatch(new Span("Vermont", 4), { classification: "locality", confidence: 0.5 })

	// range = end - start = 11 - 4 = 7; confidence = 0.5 * 7 = 3.5
	expect(calculateRangeScore(match)).toEqual({ range: 7, confidence: 3.5 })
})

test("calculateRangeScore: a parent span sums child ranges (gaps excluded)", () => {
	const parent = new Span("123    Main") // a 4-space gap between children
	parent.children.add(new Span("123", 0), new Span("Main", 7))
	const match = new SolutionMatch(parent, { classification: "street", confidence: 1 })

	// child ranges: (3-0) + (11-7) = 3 + 4 = 7 — the interior gap is NOT counted
	expect(calculateRangeScore(match)).toEqual({ range: 7, confidence: 7 })
})

test("calculateRangeScore: confidence scales the range linearly", () => {
	const match = new SolutionMatch(new Span("90210", 0), { classification: "postcode", confidence: 0.2 })

	// range 5, confidence 0.2 * 5 = 1
	expect(calculateRangeScore(match)).toEqual({ range: 5, confidence: 1 })
})

//#endregion
