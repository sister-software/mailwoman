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
})
