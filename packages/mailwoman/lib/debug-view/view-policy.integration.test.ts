/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The opening zoom against correctly ordered hierarchies. `GeocodeResult.hierarchy` is most specific first.
 *   A lookup from the other end is a defect this test catches: every returned value is a legal zoom and the map
 *   still renders. The only symptom is that a resolved city opens on a view of the continent.
 */

import { describe, expect, it } from "vitest"

import { initialZoomForTier } from "#debug-view/view-policy"
import type { GeocodeResult } from "#geocode"

/**
 * A result at `tier` whose hierarchy runs deepest-first, the order the geocoder actually produces.
 */
function resultOf(tier: GeocodeResult["resolution_tier"], tags: string[]): GeocodeResult {
	return {
		resolution_tier: tier,
		hierarchy: tags.map((tag) => ({ tag, value: tag, name: tag })),
	} as GeocodeResult
}

describe("initialZoomForTier", () => {
	it("opens a house-grade fix tight, whatever its hierarchy says", () => {
		expect(initialZoomForTier(resultOf("address_point", ["locality", "region", "country"]))).toBe(15)
		expect(initialZoomForTier(resultOf("interpolated", ["locality", "region", "country"]))).toBe(15)
	})

	it("reads the DEEPEST admin node, not the country at the far end", () => {
		// "Portland, Oregon" resolved to its locality: z11 rather than the whole-country z4 the tail read gave.
		expect(initialZoomForTier(resultOf("admin", ["locality", "region", "country"]))).toBe(11)
		expect(initialZoomForTier(resultOf("admin", ["dependent_locality", "locality", "region", "country"]))).toBe(11)

		// A region-only answer stays wider.
		// A country-only answer is widest.
		expect(initialZoomForTier(resultOf("admin", ["region", "country"]))).toBe(6)
		expect(initialZoomForTier(resultOf("admin", ["country"]))).toBe(4)
	})

	it("falls back to the widest zoom when nothing resolved", () => {
		expect(initialZoomForTier(resultOf("admin", []))).toBe(4)
	})
})
