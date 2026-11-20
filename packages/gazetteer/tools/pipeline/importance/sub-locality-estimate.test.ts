// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { estimateFromHierarchy, type HierarchyPlace } from "#tools/pipeline/importance/sub-locality-estimate"

const place = (id: number, placetype: string, parentID: number, population: number | null = null): HierarchyPlace => ({
	id,
	placetype,
	parentID,
	population,
})

// A city of 1,000,000 with four boroughs, two measured.
// One borough holds two neighborhoods.
// A second city's only borough records the whole city's figure, and a county holds a neighborhood directly.
const places: HierarchyPlace[] = [
	place(1, "locality", 0, 1_000_000),
	place(10, "borough", 1, 250_000),
	place(11, "borough", 1, 150_000),
	place(12, "borough", 1),
	place(13, "borough", 1),
	place(120, "neighbourhood", 12),
	place(121, "neighbourhood", 12),
	place(2, "locality", 0, 500_000),
	place(20, "borough", 2, 500_000),
	place(200, "neighbourhood", 20),
	place(3, "county", 0, 2_000_000),
	place(300, "neighbourhood", 3),
]

describe("estimateFromHierarchy", () => {
	const { estimates, calibration, stats } = estimateFromHierarchy(places)
	const byID = new Map(estimates.map((e) => [e.id, e]))

	test("divides the containing settlement among its same-placetype children plus one", () => {
		expect(byID.get(12)?.population).toBe(1_000_000 / 5)
		expect(byID.get(120)?.population).toBe(1_000_000 / 5 / 3)
	})

	test("never estimates a measured place, and never gives a share of a non-settlement", () => {
		expect(byID.has(10)).toBe(false)
		expect(byID.has(300)).toBe(false)
		expect(stats).toMatchObject({ subLocalities: 9, measured: 3, measuredAsWhole: 1, estimated: 5, unestimable: 1 })
	})

	test("divides a measured figure equal to the parent's as an estimate of the part", () => {
		expect(byID.get(200)?.population).toBe(500_000 / 2 / 2)
	})

	test("every estimate is smaller than the base it divides", () => {
		const population = new Map(places.map((p) => [p.id, p.population]))

		for (const e of estimates) {
			const parentBase = population.get(e.parentID) ?? byID.get(e.parentID)?.population ?? Infinity
			expect(e.population).toBeLessThan(parentBase)
		}
	})

	test("ranks by the point estimate scaled by the measured lower decile, never above the point estimate", () => {
		// The two measured boroughs compare as 250,000 / 200,000 and 150,000 / 200,000.
		// The 500,000 one is the whole city's figure.
		expect(calibration?.compared).toBe(2)
		expect(calibration?.rankFactor).toBeCloseTo(0.75)

		for (const e of estimates) {
			expect(e.rankPopulation).toBeCloseTo(e.population * calibration!.rankFactor)
		}
	})

	test("writes no estimate without a measured sub-locality to calibrate against", () => {
		const uncalibrated = estimateFromHierarchy([place(1, "locality", 0, 1000), place(10, "borough", 1)])

		expect(uncalibrated.estimates).toEqual([])
		expect(uncalibrated.calibration).toBeNull()
	})
})
