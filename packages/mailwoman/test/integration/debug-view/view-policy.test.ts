/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The opening zoom, against correctly-ordered hierarchies. `GeocodeResult.hierarchy` is MOST SPECIFIC FIRST, and
 *   reading the other end is a silent defect of exactly this shape: every value it returns is a legal zoom, the map
 *   still renders, and the only symptom is that a resolved city opens on a view of the continent.
 */

import { initialZoomForTier } from "mailwoman/debug-view/view-policy"
import type { GeocodeResult } from "mailwoman/geocode-core"
import { describe, expect, it } from "vitest"

/**
 * A result at `tier` whose hierarchy runs deepest-first, the order the geocoder actually produces.
 */
function resultOf(tier: GeocodeResult["resolution_tier"], tags: string[]): GeocodeResult {
	return {
		resolution_tier: tier,
		hierarchy: tags.map((tag) => ({ tag, value: tag, name: tag })),
	} as unknown as GeocodeResult
}

describe("initialZoomForTier", () => {
	it("opens a house-grade fix tight, whatever its hierarchy says", () => {
		expect(initialZoomForTier(resultOf("address_point", ["locality", "region", "country"]))).toBe(15)
		expect(initialZoomForTier(resultOf("interpolated", ["locality", "region", "country"]))).toBe(15)
	})

	it("reads the DEEPEST admin node, not the country at the far end", () => {
		// "Portland, Oregon" resolved to its locality: z11, not the whole-country z4 the tail read gave.
		expect(initialZoomForTier(resultOf("admin", ["locality", "region", "country"]))).toBe(11)
		expect(initialZoomForTier(resultOf("admin", ["dependent_locality", "locality", "region", "country"]))).toBe(11)

		// A region-only answer stays wider, and a country-only answer widest.
		expect(initialZoomForTier(resultOf("admin", ["region", "country"]))).toBe(6)
		expect(initialZoomForTier(resultOf("admin", ["country"]))).toBe(4)
	})

	it("falls back to the widest zoom when nothing resolved", () => {
		expect(initialZoomForTier(resultOf("admin", []))).toBe(4)
	})
})
