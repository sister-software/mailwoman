import { describe, expect, it } from "vitest"

import {
	betaQuantile,
	clopperPearson,
	regularizedBeta,
	studentTUpperQuantile,
} from "#tools/eval-harness/release/bounds"

describe("bounds", () => {
	it("matches closed forms of the incomplete beta function", () => {
		// I_x(a, 1) = x^a and I_x(1, b) = 1 - (1 - x)^b.
		expect(regularizedBeta(0.3, 2.5, 1)).toBeCloseTo(0.3 ** 2.5, 12)
		expect(regularizedBeta(0.3, 1, 4)).toBeCloseTo(1 - 0.7 ** 4, 12)
		expect(betaQuantile(regularizedBeta(0.42, 3, 7), 3, 7)).toBeCloseTo(0.42, 9)
	})

	it("gives the exact Clopper–Pearson bounds at zero and full counts", () => {
		expect(clopperPearson(0, 10, 0.025)).toEqual({ lower: 0, upper: expect.closeTo(1 - 0.025 ** (1 / 10), 9) })
		expect(clopperPearson(10, 10, 0.025)).toEqual({ lower: expect.closeTo(0.025 ** (1 / 10), 9), upper: 1 })
	})

	it("matches tabulated Student t quantiles", () => {
		expect(studentTUpperQuantile(0.025, 10)).toBeCloseTo(2.228139, 5)
		expect(studentTUpperQuantile(0.005, 30)).toBeCloseTo(2.749996, 5)
		expect(studentTUpperQuantile(0.025, 1)).toBeCloseTo(12.7062, 3)
	})
})
