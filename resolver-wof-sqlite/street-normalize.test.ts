/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The collision contract for the address-point normalizer (#476): variants that refer to the same
 *   street MUST normalize identically; distinct streets must not. Build-side and lookup-side both
 *   import the same function, so these tests are the whole correctness story for the keying.
 */

import { describe, expect, it } from "vitest"

import { canonicalizeRouteKey, normalizeLocalityForKey, normalizeStreetForKey } from "./street-normalize.js"

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

	it("folds a spelled ordinal before a street suffix to digit form (#723)", () => {
		expect(normalizeStreetForKey("Tenth St")).toEqual(normalizeStreetForKey("10th Street"))
		expect(normalizeStreetForKey("Fifth Avenue")).toEqual(normalizeStreetForKey("5th Ave"))
		expect(normalizeStreetForKey("Twentieth St")).toEqual("20th street")
	})

	it("does NOT fold an ordinal WORD that is not followed by a street suffix", () => {
		// "First National Bank Rd" — "First" is a name prefix here, not an ordinal cross-street.
		expect(normalizeStreetForKey("First National Bank Rd")).toContain("first")
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

describe("canonicalizeRouteKey", () => {
	it("folds TIGER and E911/Overture route spellings to the same key", () => {
		// TIGER "State Rte 100" → normalizeStreetForKey → "state route 100" already; the E911
		// spelling needs the designator fold to meet it.
		expect(canonicalizeRouteKey(normalizeStreetForKey("State Rte 100"))).toEqual("state route 100")
		expect(canonicalizeRouteKey(normalizeStreetForKey("VT ROUTE 100"))).toEqual("state route 100")
		expect(canonicalizeRouteKey(normalizeStreetForKey("US Hwy 5"))).toEqual("us route 5")
		expect(canonicalizeRouteKey(normalizeStreetForKey("US ROUTE 5"))).toEqual("us route 5")
	})

	it("keeps the post-designator tail (letter suffixes, trailing directionals)", () => {
		expect(canonicalizeRouteKey(normalizeStreetForKey("State Rte 22A"))).toEqual("state route 22a")
		expect(canonicalizeRouteKey(normalizeStreetForKey("VT ROUTE 22A"))).toEqual("state route 22a")
		expect(canonicalizeRouteKey(normalizeStreetForKey("US Hwy 5 S"))).toEqual(
			canonicalizeRouteKey(normalizeStreetForKey("US ROUTE 5 S"))
		)
	})

	it("never folds non-route names", () => {
		expect(canonicalizeRouteKey(normalizeStreetForKey("State Street"))).toEqual("state street")
		expect(canonicalizeRouteKey(normalizeStreetForKey("Old Route 100"))).toEqual("old route 100")
		// Bare "Route N" stays unfolded — the designator (US vs state) is unknown.
		expect(canonicalizeRouteKey(normalizeStreetForKey("Route 100"))).toEqual("route 100")
	})
})
