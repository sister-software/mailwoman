/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	isPostcodeFormat,
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "./rules.js"
import type { NormalizedInputLite, QueryShapeLike } from "./types.js"

const input = (normalized: string): NormalizedInputLite => ({ raw: normalized, normalized })
const fmt = (format: string, start: number, end: number, confidence = 0.9) => ({
	format,
	span: { start, end },
	confidence,
})
const shape = (o: Partial<QueryShapeLike> = {}): QueryShapeLike => ({ knownFormats: [], ...o })

test("isPostcodeFormat: set membership avoids the `us_zip4.endsWith('_zip')` false-negative trap", () => {
	expect(isPostcodeFormat("us_zip")).toBe(true)
	expect(isPostcodeFormat("us_zip4")).toBe(true) // the trap: a naive endsWith('_zip') would miss this
	expect(isPostcodeFormat("uk_postcode")).toBe(true)
	expect(isPostcodeFormat("po_box")).toBe(false)
	expect(isPostcodeFormat("nonsense")).toBe(false)
})

test("scorePoBox: fires (boosted) on a po_box format hit, zero otherwise", () => {
	expect(scorePoBox(input("PO Box 123"), shape({ knownFormats: [fmt("po_box", 0, 6, 0.8)] }))).toBeCloseTo(0.9, 5)
	expect(scorePoBox(input("PO Box 123"), shape({ knownFormats: [fmt("po_box", 0, 6, 0.95)] }))).toBe(1) // capped
	expect(scorePoBox(input("350 5th Ave"), shape())).toBe(0)
})

test("scoreIntersection: matches conventional intersection phrasings", () => {
	expect(scoreIntersection(input("corner of 5th and Main"), shape())).toBe(0.85)
	expect(scoreIntersection(input("Broadway & 42nd"), shape())).toBe(0.85)
	expect(scoreIntersection(input("350 5th Ave"), shape())).toBe(0)
})

test("scoreLandmark: fires when the text leads with a relative-location phrase", () => {
	expect(scoreLandmark(input("behind the stadium"), shape())).toBe(0.9)
	expect(scoreLandmark(input("Near the park"), shape())).toBe(0.9) // case-insensitive
	expect(scoreLandmark(input("Main Street"), shape())).toBe(0)
})

test("scoreVenueLandmark: short capitalized non-address phrases; rejects addresses", () => {
	expect(scoreVenueLandmark(input("Pier 39"), shape())).toBe(0.88) // internal number
	expect(scoreVenueLandmark(input("Grand Central Terminal"), shape())).toBe(0.88) // all proper-case
	// rejected: number-leading (looks like a house number)
	expect(scoreVenueLandmark(input("350 5th Ave"), shape())).toBe(0)
	// rejected: contains a street suffix
	expect(scoreVenueLandmark(input("Main Street"), shape())).toBe(0)
	// rejected: a postcode format hit is present
	expect(scoreVenueLandmark(input("Pier 39"), shape({ knownFormats: [fmt("us_zip", 0, 5)] }))).toBe(0)
	// rejected: too long
	expect(scoreVenueLandmark(input("x".repeat(60)), shape())).toBe(0)
})

test("scorePostcodeOnly: a bare postcode fires; a postcode buried in an address does not", () => {
	// "10118" — the hit covers 100% of the input
	expect(scorePostcodeOnly(input("10118"), shape({ knownFormats: [fmt("us_zip", 0, 5)] }))).toBeGreaterThan(0.8)
	// "350 5th Ave 10118" — the postcode covers <70%, so the rule stays silent (it's structured)
	expect(scorePostcodeOnly(input("350 5th Ave 10118"), shape({ knownFormats: [fmt("us_zip", 12, 17)] }))).toBe(0)
	// no postcode hit
	expect(scorePostcodeOnly(input("10118"), shape())).toBe(0)
})

test("scoreLocalityOnly: short, alpha, ≤2 segments, no format hits", () => {
	expect(scoreLocalityOnly(input("Paris"), shape({ characterClass: "alpha" }))).toBe(0.85)
	// rejected: a format hit present
	expect(
		scoreLocalityOnly(input("Paris"), shape({ characterClass: "alpha", knownFormats: [fmt("fr_postcode", 0, 5)] }))
	).toBe(0)
	// rejected: not pure-alpha
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
