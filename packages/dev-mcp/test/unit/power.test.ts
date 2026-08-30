/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A 10-input probe saw no differences and published "zero effect".
 * These tests pin the arithmetic AND the sentence because the sentence is the part that travels.
 */

import { describeObservedRate, wilsonInterval, zeroEventUpperBound } from "@mailwoman/dev-mcp/power"
import { describe, expect, it } from "vitest"

describe("zeroEventUpperBound", () => {
	it("matches the exact Clopper-Pearson limit at the size that caused the incident", () => {
		// 1 − 0.05^(1/10) = 0.2589…
		expect(zeroEventUpperBound(10)).toBeCloseTo(0.2589, 4)
	})

	it("is tighter than the rule-of-three approximation, which is why it is used", () => {
		// The approximation gives 3/10 = 0.30. At the small n where this is read, the gap is 4 percentage points.
		expect(zeroEventUpperBound(10)).toBeLessThan(3 / 10)
	})

	it("shrinks as the denominator grows", () => {
		expect(zeroEventUpperBound(837)).toBeLessThan(zeroEventUpperBound(100))
		expect(zeroEventUpperBound(100)).toBeLessThan(zeroEventUpperBound(10))
	})
})

describe("wilsonInterval", () => {
	it("brackets the point estimate", () => {
		const interval = wilsonInterval(24, 837)

		expect(interval.low).toBeLessThan(24 / 837)
		expect(interval.high).toBeGreaterThan(24 / 837)
	})

	it("never leaves [0, 1]", () => {
		expect(wilsonInterval(0, 5).low).toBeGreaterThanOrEqual(0)
		expect(wilsonInterval(5, 5).high).toBeLessThanOrEqual(1)
	})
})

describe("describeObservedRate", () => {
	it("refuses to let a small zero read as absence — the 2026-08-15 repair", () => {
		const reading = describeObservedRate({
			events: 0,
			n: 10,
			selection: "hand-picked",
			eventLabel: "differed",
			populationN: 837,
		})

		expect(reading.supportsAbsenceClaim).toBe(false)
		expect(reading.sentence).toContain("CANNOT support a claim of no effect")
		// The bound and the denominator are IN the sentence, not only in a field a relay can drop.
		expect(reading.sentence).toContain("25.9%")
		expect(reading.sentence).toContain("out of 837 available")
	})

	it("lets a large zero read as absence", () => {
		const reading = describeObservedRate({ events: 0, n: 837, selection: "full", eventLabel: "differed" })

		expect(reading.supportsAbsenceClaim).toBe(true)
		expect(reading.sentence).toContain("real absence")
	})

	it("distinguishes nothing-measured from a measured zero", () => {
		const reading = describeObservedRate({ events: 0, n: 0, selection: "full", eventLabel: "differed" })

		expect(reading.supportsAbsenceClaim).toBe(false)
		expect(reading.sentence).toContain("absence of a measurement")
		expect(reading.upperBound95).toBeNull()
	})

	it("reports a non-zero rate with its interval", () => {
		const reading = describeObservedRate({ events: 24, n: 837, selection: "full", eventLabel: "differed" })

		expect(reading.sentence).toContain("24 of 837")
		expect(reading.sentence).toContain("2.9%")
		expect(reading.sentence).toContain("95% CI")
	})

	it("names a hand-picked sample as hand-picked in the sentence", () => {
		const reading = describeObservedRate({ events: 3, n: 10, selection: "hand-picked", eventLabel: "regressed" })

		expect(reading.sentence).toContain("hand-picked")
	})
})
