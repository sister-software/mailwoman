/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	DISTANCE_THRESHOLDS_KM,
	distanceKm,
	gradeAtThreshold,
	hitAt,
	thresholdTable,
	tostEquivalence,
} from "./geo-grade.ts"

const PARIS = { lat: 48.8566, lon: 2.3522 }

describe("distanceKm", () => {
	it("answers null for an arm that returned no coordinate, never a large number", () => {
		expect(distanceKm({ lat: null, lon: null }, PARIS.lat, PARIS.lon)).toBeNull()
	})

	it("measures a real displacement", () => {
		// Lyon is ~391.5 km from Paris; the exact figure matters less than that it is not 0 and not Infinity.
		expect(distanceKm({ lat: 45.764, lon: 4.8357 }, PARIS.lat, PARIS.lon)).toBeCloseTo(391.5, 1)
	})
})

describe("hitAt", () => {
	it("counts a no-result as a miss at EVERY threshold, per the pre-registered protocol", () => {
		for (const threshold of DISTANCE_THRESHOLDS_KM) {
			expect(hitAt(null, threshold)).toBe(false)
		}
	})

	it("is inclusive at the boundary", () => {
		expect(hitAt(25, 25)).toBe(true)
	})
})

describe("gradeAtThreshold", () => {
	it("grades on crossing the threshold, not on being closer", () => {
		// 40km → 30km is a real improvement in distance and no improvement in outcome: neither arm found the address.
		expect(gradeAtThreshold(40, 30, 25)).toBe("neutral")
		expect(gradeAtThreshold(40, 20, 25)).toBe("improved")
		expect(gradeAtThreshold(20, 40, 25)).toBe("regressed")
	})

	it("reads a lost coordinate as a regression", () => {
		expect(gradeAtThreshold(2, null, 25)).toBe("regressed")
	})
})

describe("thresholdTable", () => {
	it("counts both arms at every threshold and signs the delta toward B", () => {
		const rows = [
			{ distanceKmA: 0.5, distanceKmB: 0.4 },
			{ distanceKmA: 30, distanceKmB: 3 },
			{ distanceKmA: null, distanceKmB: 20 },
			{ distanceKmA: 2, distanceKmB: null },
		]

		const table = thresholdTable(rows)

		expect(table["1km"]).toEqual({ a: 1, b: 1, delta_pp: 0, of: 4 })
		expect(table["5km"]).toEqual({ a: 2, b: 2, delta_pp: 0, of: 4 })
		expect(table["25km"]!.a).toBe(2)
		expect(table["25km"]!.b).toBe(3)
		expect(table["25km"]!.delta_pp).toBeCloseTo(25, 5)
	})
})

describe("tostEquivalence", () => {
	it("declines to claim parity from an underpowered run, and says that is what happened", () => {
		// Identical rates on 20 rows. The point estimate is exactly 0pp — the reading a naive eyeball calls parity —
		// and the interval is far too wide to place inside ±5pp.
		const reading = tostEquivalence(16, 16, 20)

		expect(reading.delta_pp).toBe(0)
		expect(reading.equivalent).toBe(false)
		expect(reading.sentence).toContain("cannot claim they are the same")
	})

	it("declares equivalence only when the whole interval sits inside the bound", () => {
		const reading = tostEquivalence(1700, 1704, 2000)

		expect(reading.equivalent).toBe(true)
		expect(reading.sentence).toContain("Equivalent at ±5pp")
	})

	it("reports a real gap as not equivalent", () => {
		const reading = tostEquivalence(250, 150, 400)

		expect(reading.equivalent).toBe(false)
		expect(reading.delta_pp).toBeCloseTo(-25, 5)
	})

	it("calls an empty set the absence of a measurement rather than a failure to be equivalent", () => {
		const reading = tostEquivalence(0, 0, 0)

		expect(reading.equivalent).toBe(false)
		expect(reading.sentence).toContain("absence of a measurement")
	})
})

describe("tostEquivalence — the degenerate sample", () => {
	it("does not read two-for-two as parity, where the normal approximation has no variance at all", () => {
		const reading = tostEquivalence(2, 2, 2)

		expect(reading.delta_pp).toBe(0)
		expect(reading.equivalent).toBe(false)
		expect(reading.sentence).toContain("NOT inside")
		expect(reading.sentence).toContain("edge of the scale")
	})

	it("never calls a total wipeout equivalent, which is the other way to reach a zero standard error", () => {
		// pA = 1 and pB = 0 both sit at the edge, so the pooled variance is zero while the arms are as far apart as
		// they can be. An equivalence test that keys on the standard error alone declares parity here.
		const reading = tostEquivalence(50, 0, 50)

		expect(reading.delta_pp).toBe(-100)
		expect(reading.equivalent).toBe(false)
	})

	it("does declare equivalence when both arms are saturated on a large enough set", () => {
		const reading = tostEquivalence(4000, 4000, 4000)

		expect(reading.equivalent).toBe(true)
	})
})
