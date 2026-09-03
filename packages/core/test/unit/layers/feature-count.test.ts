/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { declaredFeatureCount, limitedFeatureCount } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

describe("limitedFeatureCount", () => {
	it("is the layer's count when no limit is given", () => {
		expect(limitedFeatureCount(5, undefined)).toBe(5)
	})

	it("is the limit when the limit is below the layer's count", () => {
		expect(limitedFeatureCount(5, 3)).toBe(3)
	})

	it("is clamped to the layer's count when the limit exceeds it, so a complete read is not a short one", () => {
		expect(limitedFeatureCount(5, 1_000_000)).toBe(5)
	})
})

describe("declaredFeatureCount", () => {
	it("defers to a caller-supplied range count, including zero", () => {
		expect(declaredFeatureCount({ declared: 2, limit: 1_000_000, layerCount: 5 })).toBe(2)
		expect(declaredFeatureCount({ declared: 0, layerCount: 5 })).toBe(0)
	})

	it("falls back to the bounded layer count", () => {
		expect(declaredFeatureCount({ limit: 3, layerCount: 5 })).toBe(3)
		expect(declaredFeatureCount({ layerCount: 5 })).toBe(5)
	})
})
