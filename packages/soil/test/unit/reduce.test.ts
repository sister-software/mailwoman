/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The reduction's arithmetic: what the four absence shares mean, why class 8 is not one of them, and the
 *   invariant that makes `other_share` load-bearing rather than decorative.
 */

import type { SoilCapabilityCellTable } from "@mailwoman/soil/schema"
import { mapUnitProfile, shareTotal } from "@mailwoman/soil/sdk/reduce"
import { describe, expect, it } from "vitest"

function component(comppct: number, compkind: string | null, nirrcapcl: string | null) {
	return { comppct_r: comppct, compkind, nirrcapcl }
}

describe("mapUnitProfile", () => {
	it("keeps a 45/35/20 mixture as three shares rather than inventing a winner", () => {
		const profile = mapUnitProfile({ no_mapping: 0 }, [
			component(45, "Series", "2"),
			component(35, "Series", "3"),
			component(20, "Series", "6"),
		])

		expect(profile.classShares.get("2")).toBeCloseTo(0.45, 6)
		expect(profile.classShares.get("3")).toBeCloseTo(0.35, 6)
		expect(profile.classShares.get("6")).toBeCloseTo(0.2, 6)
		expect(profile.unrated).toBe(0)
	})

	it("normalizes by the weight actually present rather than assuming the percentages sum to 100", () => {
		// Measured on IA153 all 152 map units sum to exactly 100. A national build must not depend on that holding
		// everywhere, and a profile that divided by a hard-coded 100 would silently under-report every share.
		const profile = mapUnitProfile({ no_mapping: 0 }, [component(30, "Series", "2"), component(30, "Series", "3")])

		expect(profile.classShares.get("2")).toBeCloseTo(0.5, 6)
		expect(profile.classShares.get("3")).toBeCloseTo(0.5, 6)
	})

	it("separates a not-rateable miscellaneous area from an unrated named soil", () => {
		const profile = mapUnitProfile({ no_mapping: 0 }, [
			component(60, "Miscellaneous area", null),
			component(40, "Series", null),
		])

		// Read as one number both would say "not arable", which neither of them says: a water body is ground the rating
		// does not apply to, and an unrated series is ground the survey chose not to rate.
		expect(profile.notRateable).toBeCloseTo(0.6, 6)
		expect(profile.unrated).toBeCloseTo(0.4, 6)
		expect(profile.classShares.size).toBe(0)
	})

	it("puts a rated class 8 in the class shares, never in an absence share", () => {
		const profile = mapUnitProfile({ no_mapping: 0 }, [component(100, "Series", "8")])

		// Class 8 is a DETERMINATION — the survey looked and rated the land as precluding commercial plant production —
		// and 67,547 national components carry it. Folding it in with the absences is the reassuring wrong number.
		expect(profile.classShares.get("8")).toBe(1)
		expect(profile.unrated).toBe(0)
		expect(profile.notRateable).toBe(0)
		expect(profile.noData).toBe(0)
	})

	it("gives a no-mapping map unit nothing but nodata, whatever its components say", () => {
		const profile = mapUnitProfile({ no_mapping: 1 }, [component(100, "Series", "2")])

		expect(profile.noData).toBe(1)
		expect(profile.classShares.size).toBe(0)
	})

	it("treats a map unit whose components carry no weight at all as no mapping rather than as a rating", () => {
		const profile = mapUnitProfile({ no_mapping: 0 }, [component(0, "Series", "2"), component(0, "Series", "3")])

		// Nothing can be apportioned from an unweighted mixture. Answering with an empty distribution would drop the
		// delineation's area out of every share and break the sum-to-one invariant silently.
		expect(profile.noData).toBe(1)
		expect(profile.classShares.size).toBe(0)
	})
})

describe("shareTotal", () => {
	it("sums to one across the class shares and the four absences", () => {
		const row: SoilCapabilityCellTable = {
			h3_cell: 1,
			class_shares: JSON.stringify({ "2": 0.5, "3": 0.2 }),
			unrated_share: 0.1,
			notrateable_share: 0.05,
			nodata_share: 0.1,
			other_share: 0.05,
			mapped_share: 1,
			top_class: "2",
			top_class_share: 0.5,
			weighting: "cell_area_x_comppct_r",
			delineations: 3,
		}

		expect(shareTotal(row)).toBeCloseTo(1, 9)
	})
})
