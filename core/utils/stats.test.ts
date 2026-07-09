/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { formatPercent, median, percentile } from "./stats.ts"

describe("stats", () => {
	it("percentile matches the gate scripts' nearest-rank shape", () => {
		// The exact copy migrated from oa-resolver-eval/resolver-eval — gate parity depends on THIS
		// semantics: sort ascending, index = floor(p/100 * n), clamped.
		const xs = [10, 1, 5, 3, 8]
		expect(percentile(xs, 50)).toBe(5)
		expect(percentile(xs, 90)).toBe(10)
		expect(percentile(xs, 0)).toBe(1)
		expect(percentile(xs, 100)).toBe(10)
		expect(percentile([], 50)).toBeNull()
		expect(xs).toEqual([10, 1, 5, 3, 8]) // input not mutated
	})

	it("median is percentile(50)", () => {
		expect(median([3, 1, 2])).toBe(2)
		expect(median([])).toBeNull()
	})

	it("formatPercent renders k/n with digits and an em-dash on zero denominator", () => {
		expect(formatPercent(1, 8)).toBe("12.5%")
		expect(formatPercent(1, 3, 2)).toBe("33.33%")
		expect(formatPercent(0, 0)).toBe("—")
	})
})
