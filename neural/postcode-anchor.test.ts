/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the postcode anchor (#240). Drives `extractPostcodeAnchors` with an in-memory fake
 *   resolver so the anchor logic — country posterior, membership-vs-placement, and the
 *   membership+ambiguity confidence — is tested without a database.
 */

import { describe, expect, it } from "vitest"
import {
	editDistance1Variants,
	extractPostcodeAnchors,
	normalizePostcode,
	type PostcodePlace,
	type PostcodeResolver,
} from "./postcode-anchor.js"

/** A fake gazetteer: exact-match map from normalized postcode → hits. */
class FakeResolver implements PostcodeResolver {
	constructor(private readonly map: Record<string, PostcodePlace[]>) {}
	lookup(postcode: string): PostcodePlace[] {
		return this.map[postcode] ?? []
	}
}

const RESOLVER = new FakeResolver({
	// single-country, placed
	"94105": [{ country: "US", lat: 37.789, lon: -122.396 }],
	// ambiguous: a real code in two countries
	"75001": [
		{ country: "FR", lat: 48.862, lon: 2.336 },
		{ country: "US", lat: 35.9, lon: -90.7 },
	],
	// known postcode with NO centroid (admin parent absent) — membership only
	"80144": [{ country: "IT", lat: 0, lon: 0 }],
	// German code (would be backfilled in the real shard)
	"68161": [{ country: "DE", lat: 49.48, lon: 8.46 }],
})

describe("normalizePostcode", () => {
	it("uppercases, collapses whitespace, strips the German D- prefix", () => {
		expect(normalizePostcode(" sw1a  1aa ")).toBe("SW1A 1AA")
		expect(normalizePostcode("D-68161")).toBe("68161")
		expect(normalizePostcode("75008")).toBe("75008")
	})

	it("removes the space in a Dutch postcode so it matches the gazetteer key", () => {
		expect(normalizePostcode("1012 LM")).toBe("1012LM")
		expect(normalizePostcode("1012lm")).toBe("1012LM")
	})
})

describe("extractPostcodeAnchors", () => {
	it("single-country postcode → posterior {US:1}, confidence 1.0, one placed candidate", () => {
		const [a, ...rest] = extractPostcodeAnchors("123 Market St, San Francisco 94105", RESOLVER)
		expect(rest).toHaveLength(0)
		expect(a!.normalized).toBe("94105")
		expect(a!.posterior).toEqual({ US: 1 })
		expect(a!.confidence).toBe(1)
		expect(a!.candidates).toEqual([{ country: "US", lat: 37.789, lon: -122.396 }])
	})

	it("ambiguous postcode → uniform posterior over both countries, moderate confidence", () => {
		const [a] = extractPostcodeAnchors("75001 Paris", RESOLVER)
		expect(a!.posterior).toEqual({ FR: 0.5, US: 0.5 })
		// 1 - log2(2)/log2(10)
		expect(a!.confidence).toBeCloseTo(0.699, 3)
		expect(a!.candidates.map((c) => c.country)).toEqual(["FR", "US"])
	})

	it("regex-shaped string that is in no gazetteer → confidence 0 (parser treats it as a house number)", () => {
		// 48823 matches the 5-digit shape but is absent from the fake gazetteer.
		const [a] = extractPostcodeAnchors("48823 Anywhere Road", RESOLVER)
		expect(a!.normalized).toBe("48823")
		expect(a!.posterior).toEqual({})
		expect(a!.confidence).toBe(0)
		expect(a!.candidates).toEqual([])
	})

	it("known postcode with no centroid → present in posterior, absent from candidates", () => {
		const [a] = extractPostcodeAnchors("80144 Napoli", RESOLVER)
		expect(a!.posterior).toEqual({ IT: 1 })
		expect(a!.confidence).toBe(1)
		expect(a!.candidates).toEqual([]) // membership without placement
	})

	it("normalizes the German D- prefix before resolving", () => {
		const [a] = extractPostcodeAnchors("Mannheim D-68161", RESOLVER)
		expect(a!.normalized).toBe("68161")
		expect(a!.posterior).toEqual({ DE: 1 })
	})

	it("reports the span offsets of the matched substring", () => {
		const text = "Foo 94105 Bar"
		const [a] = extractPostcodeAnchors(text, RESOLVER)
		expect(text.slice(a!.span.start, a!.span.end)).toBe("94105")
	})

	it("returns multiple anchors for multiple postcodes", () => {
		const anchors = extractPostcodeAnchors("94105 ... 75001", RESOLVER)
		expect(anchors).toHaveLength(2)
		expect(anchors.map((a) => a.normalized).sort()).toEqual(["75001", "94105"])
	})

	it("tags an exact hit with matchType 'exact'", () => {
		const [a] = extractPostcodeAnchors("94105", RESOLVER)
		expect(a!.matchType).toBe("exact")
	})
})

describe("extractPostcodeAnchors — position-aware confidence (house-number disambiguation)", () => {
	// A gazetteer where 12345 and 90210 are both real US codes, so membership alone cannot tell a
	// code-shaped house number from a real postcode — only position can.
	const R = new FakeResolver({
		"12345": [{ country: "US", lat: 42.1, lon: -72.6 }],
		"90210": [{ country: "US", lat: 34.1, lon: -118.4 }],
		"SW1A 1AA": [{ country: "GB", lat: 51.5, lon: -0.12 }],
	})

	it("down-weights a real-code-shaped span sharing a street segment (likely a house number)", () => {
		const [a] = extractPostcodeAnchors("12345 Main Street, Springfield", R)
		expect(a!.matchType).toBe("exact") // the gazetteer still vouches for the shape
		expect(a!.positionFactor).toBeLessThan(1)
		expect(a!.confidence).toBeCloseTo(0.2, 5) // 1.0 (single country) × house-number penalty
	})

	it("keeps full confidence for the same code in a city segment (a real postcode)", () => {
		const [a] = extractPostcodeAnchors("Springfield, MA 12345", R)
		expect(a!.positionFactor).toBe(1)
		expect(a!.confidence).toBe(1)
	})

	it("ranks the city-segment postcode above a street-segment house number in one address", () => {
		const anchors = extractPostcodeAnchors("12345 Main Street, Anytown, CA 90210", R)
		expect(anchors).toHaveLength(2)
		expect(anchors[0]!.normalized).toBe("12345") // the leading house number
		expect(anchors[1]!.normalized).toBe("90210") // the trailing postcode
		expect(anchors[0]!.confidence).toBeLessThan(anchors[1]!.confidence)
	})

	it("never penalizes an alphanumeric code — letters cannot be a house number", () => {
		const [a] = extractPostcodeAnchors("10 Downing Street, London SW1A 1AA", R)
		expect(a!.positionFactor).toBe(1)
		expect(a!.confidence).toBe(1)
	})

	it("matches an agglutinative compound street (German Straße) by suffix", () => {
		const [a] = extractPostcodeAnchors("Straußstraße 12345, Berlin", R)
		expect(a!.positionFactor).toBeLessThan(1) // 12345 shares its segment with Straußstraße
	})
})

describe("editDistance1Variants", () => {
	it("covers deletions, same-class substitutions, insertions, and transpositions", () => {
		const v = new Set(editDistance1Variants("75"))
		expect(v.has("7")).toBe(true) // deletion
		expect(v.has("5")).toBe(true) // deletion
		expect(v.has("57")).toBe(true) // transposition
		expect(v.has("76")).toBe(true) // substitution (digit→digit)
		expect(v.has("750")).toBe(true) // insertion
		expect(v.has("75")).toBe(false) // never the original
	})

	it("keeps substitutions within the character class (digits stay digits)", () => {
		for (const variant of editDistance1Variants("75")) {
			// every variant is digits-only (no letters introduced for a numeric postcode)
			expect(/^[0-9]*$/.test(variant)).toBe(true)
		}
	})
})

describe("extractPostcodeAnchors — fuzzy fallback", () => {
	it("is off by default: a one-typo postcode is a non-member at confidence 0", () => {
		const [a] = extractPostcodeAnchors("94155 Somewhere", RESOLVER) // 94155 is edit-1 of 94105
		expect(a!.matchType).toBe("none")
		expect(a!.confidence).toBe(0)
	})

	it("with fuzzy on, a one-typo postcode resolves to the real code with a confidence penalty", () => {
		const [a] = extractPostcodeAnchors("94155 Somewhere", RESOLVER, { fuzzy: true })
		expect(a!.matchType).toBe("fuzzy")
		expect(a!.posterior).toEqual({ US: 1 }) // recovered 94105 → US
		expect(a!.confidence).toBeCloseTo(0.6, 5) // 1.0 (single country) × fuzzy penalty
	})

	it("recovers a transposed postcode", () => {
		const [a] = extractPostcodeAnchors("94015 Somewhere", RESOLVER, { fuzzy: true }) // 1↔0 swap of 94105
		expect(a!.matchType).toBe("fuzzy")
		expect(a!.posterior).toEqual({ US: 1 })
	})

	it("an exact match never triggers the fuzzy path", () => {
		const [a] = extractPostcodeAnchors("94105", RESOLVER, { fuzzy: true })
		expect(a!.matchType).toBe("exact")
		expect(a!.confidence).toBe(1)
	})
})
