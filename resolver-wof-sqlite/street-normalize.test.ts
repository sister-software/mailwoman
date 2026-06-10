/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The collision contract for the address-point normalizer (#476): variants that refer to
 *   the same street MUST normalize identically; distinct streets must not. Build-side and
 *   lookup-side both import the same function, so these tests are the whole correctness
 *   story for the keying.
 */

import { describe, expect, it } from "vitest"

import { normalizeLocalityForKey, normalizeStreetForKey } from "./street-normalize.js"

describe("normalizeStreetForKey", () => {
	it("collides USPS suffix variants", () => {
		expect(normalizeStreetForKey("Main St")).toEqual(normalizeStreetForKey("Main Street"))
		expect(normalizeStreetForKey("Wacker Dr.")).toEqual(normalizeStreetForKey("Wacker Drive"))
		expect(normalizeStreetForKey("Fifth Ave")).toEqual(normalizeStreetForKey("Fifth Avenue"))
	})

	it("collides leading directional abbreviations (incl. compound + two-word forms)", () => {
		expect(normalizeStreetForKey("N Main St")).toEqual(normalizeStreetForKey("North Main Street"))
		expect(normalizeStreetForKey("SE Division St")).toEqual(normalizeStreetForKey("Southeast Division Street"))
		expect(normalizeStreetForKey("South East Division St")).toEqual(normalizeStreetForKey("SE Division Street"))
	})

	it("collides trailing directionals (3+ tokens)", () => {
		expect(normalizeStreetForKey("Main St N")).toEqual(normalizeStreetForKey("Main Street North"))
	})

	it("does NOT expand interior single-letter tokens (person initials)", () => {
		expect(normalizeStreetForKey("Martin L King Jr Blvd")).toContain(" l ")
	})

	it("does not collapse a bare directional-only name", () => {
		// "N" alone is a (weird but real) street name — single tokens are never expanded.
		expect(normalizeStreetForKey("N")).toEqual("n")
	})

	it("keeps numbered streets as digits and folds case/punct/diacritics", () => {
		expect(normalizeStreetForKey("5th Ave")).toEqual("5th avenue")
		expect(normalizeStreetForKey("  CALLE   José.  ")).toEqual("calle jose")
	})

	it("distinct streets stay distinct", () => {
		expect(normalizeStreetForKey("Main Street")).not.toEqual(normalizeStreetForKey("Maine Street"))
		expect(normalizeStreetForKey("North Main Street")).not.toEqual(normalizeStreetForKey("Main Street"))
	})
})

describe("normalizeLocalityForKey", () => {
	it("folds without street semantics", () => {
		expect(normalizeLocalityForKey("St. Albans")).toEqual("st albans")
		expect(normalizeLocalityForKey("Montréal")).toEqual("montreal")
	})
})
