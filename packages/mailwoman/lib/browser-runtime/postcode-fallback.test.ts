/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { serializePostcodeBinary } from "@mailwoman/postcode/binary-resolver"
import { describe, expect, it } from "vitest"

import {
	centroidLookupKey,
	loadPostcodeCentroids,
	mergePostcodeCentroids,
	postcodeCentroidFor,
	postcodeFallbackKeys,
} from "#browser-runtime/postcode-fallback"

describe("postcode fallback", () => {
	it("centroidLookupKey drops the marks at the edges, keeps the internal separator and uppercases", () => {
		expect(centroidLookupKey("〒150-0043")).toBe("150-0043")
		expect(centroidLookupKey("150-0043.")).toBe("150-0043")
		expect(centroidLookupKey(" sw1a 1aa ")).toBe("SW1A 1AA")
		expect(centroidLookupKey("〒")).toBeNull()
	})

	it("postcodeFallbackKeys reads the parse node first, then the input's known postcode formats, without repeats", () => {
		const input = "〒150-0043 東京都渋谷区道玄坂1丁目"

		const keys = postcodeFallbackKeys(null, input, [
			{ format: "jp_postcode", span: { start: 0, end: 9 }, confidence: 0.95 },
			{ format: "locality", span: { start: 10, end: 14 }, confidence: 0.5 },
		])

		expect(keys).toEqual(["150-0043"])

		expect(
			postcodeFallbackKeys("150-0043", input, [{ format: "jp_postcode", span: { start: 0, end: 9 }, confidence: 0.95 }])
		).toEqual(["150-0043"])

		expect(postcodeFallbackKeys("20500", "Washington 20500", [])).toEqual(["20500"])
	})

	it("postcodeCentroidFor answers the first placed centroid and skips the unplaced sentinel", () => {
		const lookup = new Map([
			["150-0043", { lat: 0, lon: 0 }],
			["1500043", { lat: 35.657, lon: 139.695 }],
		])

		expect(postcodeCentroidFor(lookup, ["150-0043", "1500043"])).toEqual({ key: "1500043", lat: 35.657, lon: 139.695 })
		expect(postcodeCentroidFor(lookup, ["100-0005"])).toBeNull()
	})

	it("loadPostcodeCentroids reads a PCB1 binary into a map, and mergePostcodeCentroids lets the anchors win", async () => {
		const bytes = serializePostcodeBinary([
			{ postcode: "150-0043", country: "JP", lat: 35.6572, lon: 139.6954 },
			{ postcode: "100-0005", country: "JP", lat: 35.6792, lon: 139.7668 },
		])

		const fetchImpl: typeof fetch = async () => new Response(bytes, { status: 200 })
		const centroids = await loadPostcodeCentroids(["https://example.test/postcode-jp.bin"], fetchImpl)

		// PCB1 quantizes a coordinate to a 16-bit integer, so the read-back is within 0.003 degrees of the written value.
		expect(centroids.size).toBe(2)
		expect(centroids.get("150-0043")?.lat).toBeCloseTo(35.6572, 2)
		expect(centroids.get("150-0043")?.lon).toBeCloseTo(139.6954, 2)

		const anchors = new Map([["150-0043", { lat: 1, lon: 2 }]])
		const merged = mergePostcodeCentroids(anchors, centroids)!

		expect(merged.get("150-0043")).toEqual({ lat: 1, lon: 2 })
		expect(merged.get("100-0005")?.lat).toBeCloseTo(35.6792, 2)
		expect(mergePostcodeCentroids(anchors, null)).toBe(anchors)
		expect(mergePostcodeCentroids(null, centroids)!.size).toBe(2)
	})
})
