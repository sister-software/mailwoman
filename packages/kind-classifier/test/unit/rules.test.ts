/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "@mailwoman/kind-classifier/rules"
import type { KnownFormat, NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"
import { expect, test } from "vitest"

const input = (normalized: string): NormalizedInputLite => ({ raw: normalized, normalized })

const fmt = (format: KnownFormat, start: number, end: number, confidence = 0.9) => ({
	format,
	span: { start, end },
	confidence,
})

const shape = (o: Partial<QueryShapeLike> = {}): QueryShapeLike => ({ knownFormats: [], ...o })

test("scorePoBox: fires (boosted) on a po_box format hit, zero otherwise", () => {
	expect(scorePoBox(input("PO Box 123"), shape({ knownFormats: [fmt("po_box", 0, 6, 0.8)] }))).toBeCloseTo(0.9, 5)
	// Maximum score.
	expect(scorePoBox(input("PO Box 123"), shape({ knownFormats: [fmt("po_box", 0, 6, 0.95)] }))).toBe(1)
	expect(scorePoBox(input("350 5th Ave"), shape())).toBe(0)
})

test("scoreIntersection: matches conventional intersection phrasings", () => {
	expect(scoreIntersection(input("corner of 5th and Main"), shape())).toBe(0.85)
	expect(scoreIntersection(input("Broadway & 42nd"), shape())).toBe(0.85)
	expect(scoreIntersection(input("350 5th Ave"), shape())).toBe(0)
})

test("scoreLandmark: fires when the text leads with a relative-location phrase", () => {
	expect(scoreLandmark(input("behind the stadium"), shape())).toBe(0.9)
	expect(scoreLandmark(input("Near the park"), shape())).toBe(0.9) // Case-insensitive.
	expect(scoreLandmark(input("Main Street"), shape())).toBe(0)
})

test("scoreVenueLandmark: short capitalized non-address phrases; rejects addresses", () => {
	expect(scoreVenueLandmark(input("Pier 39"), shape())).toBe(0.88) // Number follows the name.
	expect(scoreVenueLandmark(input("Grand Central Terminal"), shape())).toBe(0.88) // Proper case.
	// Reject house-number-leading input.
	expect(scoreVenueLandmark(input("350 5th Ave"), shape())).toBe(0)
	// Reject street suffixes.
	expect(scoreVenueLandmark(input("Main Street"), shape())).toBe(0)
	// Reject postcode hits.
	expect(scoreVenueLandmark(input("Pier 39"), shape({ knownFormats: [fmt("us_zip", 0, 5)] }))).toBe(0)
	// Reject overlong input.
	expect(scoreVenueLandmark(input("x".repeat(60)), shape())).toBe(0)
})

test("scorePostcodeOnly: a bare postcode fires; a postcode buried in an address does not", () => {
	// The hit covers the full input.
	expect(scorePostcodeOnly(input("10118"), shape({ knownFormats: [fmt("us_zip", 0, 5)] }))).toBeGreaterThan(0.8)
	// The postcode covers under 70% of this address.
	expect(scorePostcodeOnly(input("350 5th Ave 10118"), shape({ knownFormats: [fmt("us_zip", 12, 17)] }))).toBe(0)
	// No postcode hit.
	expect(scorePostcodeOnly(input("10118"), shape())).toBe(0)
})

test("scoreLocalityOnly: short, alpha, ≤2 segments, no format hits", () => {
	expect(scoreLocalityOnly(input("Paris"), shape({ characterClass: "alpha" }))).toBe(0.85)

	// Reject known-format hits.
	expect(
		scoreLocalityOnly(input("Paris"), shape({ characterClass: "alpha", knownFormats: [fmt("fr_postcode", 0, 5)] }))
	).toBe(0)

	// Reject non-alphabetic input.
	expect(scoreLocalityOnly(input("350 5th"), shape({ characterClass: "alphanumeric" }))).toBe(0)
})

test("scoreStructuredAddress: multi-segment alphanumeric scores highest", () => {
	const seg = (n: number) => Array.from({ length: n }, (_, i) => ({ body: `s${i}`, index: i }))

	expect(
		scoreStructuredAddress(
			input("350 5th Ave, NYC, NY 10118"),
			shape({ segments: seg(3), characterClass: "alphanumeric" })
		)
	).toBe(0.9)

	expect(scoreStructuredAddress(input("Paris"), shape({ segments: seg(1), characterClass: "alpha" }))).toBe(0)
})

test("scoreVague: a constant moderate baseline so it is always an alternative", () => {
	expect(scoreVague(input("anything"), shape())).toBe(0.3)
})
