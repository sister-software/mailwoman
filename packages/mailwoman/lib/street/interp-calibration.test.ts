// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "#street/interp-calibration"

describe("interpCalibrationForRegion (#374/#584 per-region wiring)", () => {
	it("selects the measured factor by the region's ISO 3166-2 code, in either case", () => {
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "US-DC")).toBe(1.44)
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "us-az")).toBe(3.12)
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "US-TX")).toBe(1.7)
	})

	it("falls back to the conservative default for an unmeasured region", () => {
		// FL isn't in the 12-state seed table → the deliberately-high default (rural-skewed).
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "US-FL")).toBe(INTERP_RADIUS_CALIBRATION.default)
	})

	it("reads the default for a region of another country that shares a state's letters", () => {
		// Arunachal Pradesh is `IN-AR`, and Arkansas's measured factor is a fact about `US-AR`.
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "IN-AR")).toBe(INTERP_RADIUS_CALIBRATION.default)
	})

	it("falls back to the default for an absent region (null/undefined)", () => {
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, null)).toBe(INTERP_RADIUS_CALIBRATION.default)
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, undefined)).toBe(INTERP_RADIUS_CALIBRATION.default)
	})

	it("the default is at the conservative (rural) end — never below the densest measured factor", () => {
		const measured = Object.values(INTERP_RADIUS_CALIBRATION.byRegion)
		expect(INTERP_RADIUS_CALIBRATION.default).toBeGreaterThan(Math.min(...measured))
	})
})
