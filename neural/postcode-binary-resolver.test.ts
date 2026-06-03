/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Round-trip tests for the browser flat-binary postcode resolver (#240): serialize entries, load
 *   the bytes, and assert exact-match, multi-country runs, coordinate-less membership, and
 *   quantization fidelity. Also confirms `extractPostcodeAnchors` works through it (the
 *   `PostcodeResolver` seam), so the WASM resolver is a drop-in for the SQLite one.
 */

import { describe, expect, it } from "vitest"
import { extractPostcodeAnchors } from "./postcode-anchor.js"
import {
	PostcodeBinaryResolver,
	serializePostcodeBinary,
	type PostcodeBinaryEntry,
} from "./postcode-binary-resolver.js"

const ENTRIES: PostcodeBinaryEntry[] = [
	{ postcode: "94105", country: "US", lat: 37.789, lon: -122.396 },
	{ postcode: "75008", country: "FR", lat: 48.873, lon: 2.313 },
	{ postcode: "75008", country: "US", lat: 33.02, lon: -96.83 }, // 75008 is also Carrollton, TX
	{ postcode: "1012LM", country: "NL", lat: 52.375, lon: 4.9 },
	{ postcode: "80144", country: "IT", lat: 0, lon: 0 }, // coordinate-less membership
]

function resolver(): PostcodeBinaryResolver {
	return new PostcodeBinaryResolver(serializePostcodeBinary(ENTRIES))
}

describe("PostcodeBinaryResolver", () => {
	it("rejects a buffer with a bad magic", () => {
		expect(() => new PostcodeBinaryResolver(new Uint8Array(16))).toThrow(/bad magic/)
	})

	it("exact-matches a single-country postcode and round-trips the centroid within quantization", () => {
		const [hit, ...rest] = resolver().lookup("94105")
		expect(rest).toHaveLength(0)
		expect(hit!.country).toBe("US")
		expect(hit!.lat).toBeCloseTo(37.789, 2)
		expect(hit!.lon).toBeCloseTo(-122.396, 2)
	})

	it("returns every country for a postcode shared across borders", () => {
		const hits = resolver().lookup("75008")
		expect(hits.map((h) => h.country).sort()).toEqual(["FR", "US"])
	})

	it("returns coordinate-less rows so membership survives without a centroid", () => {
		expect(resolver().lookup("80144")).toEqual([{ country: "IT", lat: 0, lon: 0 }])
	})

	it("handles keys of different lengths (US 5-digit vs NL 6-char)", () => {
		expect(
			resolver()
				.lookup("1012LM")
				.map((h) => h.country)
		).toEqual(["NL"])
		expect(
			resolver()
				.lookup("94105")
				.map((h) => h.country)
		).toEqual(["US"])
	})

	it("returns [] for an unknown postcode and for an over-long query", () => {
		expect(resolver().lookup("00000")).toEqual([])
		expect(resolver().lookup("THISISWAYTOOLONG")).toEqual([])
	})

	it("is a drop-in PostcodeResolver: extractPostcodeAnchors works through it", () => {
		const [a] = extractPostcodeAnchors("Damrak 70, 1012 LM Amsterdam", resolver())
		expect(a!.normalized).toBe("1012LM")
		expect(a!.posterior).toEqual({ NL: 1 })
		expect(a!.confidence).toBe(1)
		expect(a!.candidates[0]!.country).toBe("NL")
	})
})
