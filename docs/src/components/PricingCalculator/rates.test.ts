/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { monthlyCost, oldestReading, ProviderRates, type ProviderRate } from "./rates.ts"

const google = ProviderRates.find((rate) => rate.provider === "Google Maps Platform")!

describe("monthlyCost", () => {
	test("bills nothing inside the free allowance", () => {
		expect(monthlyCost(google, 10_000)).toBe(0)
	})

	test("takes the allowance off the first band", () => {
		// 90,000 billed at $5 per 1,000.
		expect(monthlyCost(google, 100_000)).toBe(450)
	})

	test("walks every band", () => {
		// 450 + 400,000 × 4 + 500,000 × 3 + 4,000,000 × 1.5 + 5,000,000 × 0.38, per 1,000.
		expect(monthlyCost(google, 10_000_000)).toBeCloseTo(450 + 1600 + 1500 + 6000 + 1900)
	})

	test("prices a flat rate", () => {
		const flat: ProviderRate = { ...google, freePerMonth: 0, bands: [{ upTo: Infinity, perThousand: 0.5 }] }

		expect(monthlyCost(flat, 2_000_000)).toBe(1000)
	})

	test("returns null for a quote", () => {
		expect(monthlyCost({ ...google, bands: null }, 1_000_000)).toBeNull()
	})
})

test("every rate was read within 120 days", () => {
	const age = (Date.now() - Date.parse(oldestReading())) / 86_400_000

	expect(age, `the oldest rate was read on ${oldestReading()}; re-read every source in rates.ts`).toBeLessThan(120)
})
