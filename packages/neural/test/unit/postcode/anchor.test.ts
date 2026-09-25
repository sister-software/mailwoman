import {
	editDistance1Variants,
	extractPostcodeAnchors,
	gbOutwardCode,
	normalizePostcode,
	type PostcodePlace,
	type PostcodeResolver,
} from "@mailwoman/neural/postcode"
import { describe, expect, it } from "vitest"

class FakeResolver implements PostcodeResolver {
	readonly #map: Record<string, PostcodePlace[]>

	constructor(map: Record<string, PostcodePlace[]>) {
		this.#map = map
	}
	lookup(postcode: string): PostcodePlace[] {
		return this.#map[postcode] ?? []
	}
}

const RESOLVER = new FakeResolver({
	"94105": [{ country: "US", lat: 37.789, lon: -122.396 }],

	"75001": [
		{ country: "FR", lat: 48.862, lon: 2.336 },
		{ country: "US", lat: 35.9, lon: -90.7 },
	],

	"80144": [{ country: "IT", lat: 0, lon: 0 }],

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
	it("Single-country postcode → posterior {US:1}, confidence 1.0, one placed candidate", () => {
		const [a, ...rest] = extractPostcodeAnchors("123 Market St, San Francisco 94105", RESOLVER)
		expect(rest).toHaveLength(0)
		expect(a!.normalized).toBe("94105")
		expect(a!.posterior).toEqual({ US: 1 })
		expect(a!.confidence).toBe(1)
		expect(a!.candidates).toEqual([{ country: "US", lat: 37.789, lon: -122.396 }])
	})

	it("Ambiguous postcode → uniform posterior over both countries, moderate confidence", () => {
		const [a] = extractPostcodeAnchors("75001 Paris", RESOLVER)
		expect(a!.posterior).toEqual({ FR: 0.5, US: 0.5 })

		expect(a!.confidence).toBeCloseTo(0.699, 3)
		expect(a!.candidates.map((c) => c.country)).toEqual(["FR", "US"])
	})

	it("Regex-shaped string that is in no gazetteer → confidence 0 (parser treats it as a house number)", () => {
		const [a] = extractPostcodeAnchors("48823 Anywhere Road", RESOLVER)
		expect(a!.normalized).toBe("48823")
		expect(a!.posterior).toEqual({})
		expect(a!.confidence).toBe(0)
		expect(a!.candidates).toEqual([])
	})

	it("Known postcode with no centroid → present in posterior, absent from candidates", () => {
		const [a] = extractPostcodeAnchors("80144 Napoli", RESOLVER)
		expect(a!.posterior).toEqual({ IT: 1 })
		expect(a!.confidence).toBe(1)
		expect(a!.candidates).toEqual([])
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
		expect(anchors.map((a) => a.normalized).toSorted()).toEqual(["75001", "94105"])
	})

	it("tags an exact hit with matchType 'exact'", () => {
		const [a] = extractPostcodeAnchors("94105", RESOLVER)
		expect(a!.matchType).toBe("exact")
	})
})

describe("extractPostcodeAnchors — position-aware confidence (house-number disambiguation)", () => {
	const R = new FakeResolver({
		"12345": [{ country: "US", lat: 42.1, lon: -72.6 }],
		"90210": [{ country: "US", lat: 34.1, lon: -118.4 }],
		"SW1A 1AA": [{ country: "GB", lat: 51.5, lon: -0.12 }],

		"12623": [{ country: "DE", lat: 52.48, lon: 13.6 }],
	})

	it("down-weights a real-code-shaped span sharing a street segment (likely a house number)", () => {
		const [a] = extractPostcodeAnchors("12345 Main Street, Springfield", R)
		expect(a!.matchType).toBe("exact")
		expect(a!.positionFactor).toBeLessThan(1)
		expect(a!.confidence).toBeCloseTo(0.2, 5)
	})

	it("keeps full confidence for the same code in a city segment (a real postcode)", () => {
		const [a] = extractPostcodeAnchors("Springfield, MA 12345", R)
		expect(a!.positionFactor).toBe(1)
		expect(a!.confidence).toBe(1)
	})

	it("ranks the city-segment postcode above a street-segment house number in one address", () => {
		const anchors = extractPostcodeAnchors("12345 Main Street, Anytown, CA 90210", R)
		expect(anchors).toHaveLength(2)
		expect(anchors[0]!.normalized).toBe("12345")
		expect(anchors[1]!.normalized).toBe("90210")
		expect(anchors[0]!.confidence).toBeLessThan(anchors[1]!.confidence)
	})

	it("never penalizes an alphanumeric code — letters cannot be a house number", () => {
		const [a] = extractPostcodeAnchors("10 Downing Street, London SW1A 1AA", R)
		expect(a!.positionFactor).toBe(1)
		expect(a!.confidence).toBe(1)
	})

	it("matches an agglutinative compound street (German Straße) by suffix — for a German-member code", () => {
		const [a] = extractPostcodeAnchors("Straußstraße 12623, Berlin", R)
		expect(a!.positionFactor).toBeLessThan(1)
	})

	it("CHECKS OUT a non-member system's vocabulary: a US-only code is not penalized by a German street word", () => {
		const [a] = extractPostcodeAnchors("Straußstraße 12345, Berlin", R)
		expect(a!.positionFactor).toBe(1)
	})
})

describe("editDistance1Variants", () => {
	it("covers deletions, same-class substitutions, insertions, and transpositions", () => {
		const v = new Set(editDistance1Variants("75"))
		expect(v.has("7")).toBe(true)
		expect(v.has("5")).toBe(true)
		expect(v.has("57")).toBe(true)
		expect(v.has("76")).toBe(true)
		expect(v.has("750")).toBe(true)
		expect(v.has("75")).toBe(false)
	})

	it("keeps substitutions within the character class (digits stay digits)", () => {
		for (const variant of editDistance1Variants("75")) {
			expect(/^[0-9]*$/.test(variant)).toBe(true)
		}
	})
})

describe("extractPostcodeAnchors — fuzzy fallback", () => {
	it("is off by default: a one-typo postcode is a non-member at confidence 0", () => {
		const [a] = extractPostcodeAnchors("94155 Somewhere", RESOLVER)
		expect(a!.matchType).toBe("none")
		expect(a!.confidence).toBe(0)
	})

	it("with fuzzy on, a one-typo postcode resolves to the real code with a confidence penalty", () => {
		const [a] = extractPostcodeAnchors("94155 Somewhere", RESOLVER, { fuzzy: true })
		expect(a!.matchType).toBe("fuzzy")
		expect(a!.posterior).toEqual({ US: 1 })
		expect(a!.confidence).toBeCloseTo(0.6, 5)
	})

	it("recovers a transposed postcode", () => {
		const [a] = extractPostcodeAnchors("94015 Somewhere", RESOLVER, { fuzzy: true })
		expect(a!.matchType).toBe("fuzzy")
		expect(a!.posterior).toEqual({ US: 1 })
	})

	it("an exact match never triggers the fuzzy path", () => {
		const [a] = extractPostcodeAnchors("94105", RESOLVER, { fuzzy: true })
		expect(a!.matchType).toBe("exact")
		expect(a!.confidence).toBe(1)
	})
})

describe("gbOutwardCode", () => {
	it("returns the outward code of a GB unit postcode", () => {
		expect(gbOutwardCode("SO4 3RX")).toBe("SO4")
		expect(gbOutwardCode("SW1A 2AA")).toBe("SW1A")
	})

	it("returns null for non-GB shapes (never fires elsewhere)", () => {
		expect(gbOutwardCode("75001")).toBeNull()
		expect(gbOutwardCode("1012LM")).toBeNull()
		expect(gbOutwardCode("ABC DEF")).toBeNull()
	})
})

describe("extractPostcodeAnchors — GB outward fallback", () => {
	const GB = new FakeResolver({ SW1A: [{ country: "GB", lat: 51.501, lon: -0.142 }] })

	it("resolves a GB unit to its outward district, tagged matchType 'outward', full confidence", () => {
		const [a] = extractPostcodeAnchors("221B Baker St, London SW1A 2AA", GB)
		expect(a!.matchType).toBe("outward")
		expect(a!.posterior).toEqual({ GB: 1 })
		expect(a!.candidates[0]!.country).toBe("GB")
		expect(a!.confidence).toBeGreaterThan(0.9)
	})

	it("prefers an exact hit over the outward fallback when the full code exists", () => {
		const both = new FakeResolver({
			"SW1A 2AA": [{ country: "GB", lat: 51.5, lon: -0.14 }],
			SW1A: [{ country: "GB", lat: 51.501, lon: -0.142 }],
		})

		const [a] = extractPostcodeAnchors("SW1A 2AA", both)
		expect(a!.matchType).toBe("exact")
	})
})
