// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "#interp-calibration"

describe("interpCalibrationForRegion (#374/#584 per-region wiring)", () => {
	it("selects the measured factor by region (slug is lowercase from regionToStateSlug)", () => {
		const { byRegion } = INTERP_RADIUS_CALIBRATION

		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "dc")).toBe(byRegion["DC"])
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "az")).toBe(byRegion["AZ"])
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "tx")).toBe(byRegion["TX"])
	})

	it("falls back to the conservative default for an unmeasured region", () => {
		// FL isn't in the 12-state seed table → the deliberately-high default (rural-skewed).
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "fl")).toBe(INTERP_RADIUS_CALIBRATION.default)
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
