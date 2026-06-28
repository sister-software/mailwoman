/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "./interp-calibration.js"

describe("interpCalibrationForRegion (#374/#584 per-region wiring)", () => {
	it("selects the measured factor by region (slug is lowercase from regionToStateSlug)", () => {
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "dc")).toBe(1.44)
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "az")).toBe(3.12)
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "tx")).toBe(1.7)
	})

	it("is case-insensitive on the region key", () => {
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "CA")).toBe(1.87)
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "ca")).toBe(1.87)
	})

	it("falls back to the conservative default for an unmeasured region", () => {
		// FL isn't in the 12-state seed table → the deliberately-high default (rural-skewed).
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, "fl")).toBe(INTERP_RADIUS_CALIBRATION.default)
		expect(INTERP_RADIUS_CALIBRATION.default).toBe(1.95)
	})

	it("falls back to the default for an absent region (null/undefined)", () => {
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, null)).toBe(1.95)
		expect(interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, undefined)).toBe(1.95)
	})

	it("the default is at the conservative (rural) end — never below the densest measured factor", () => {
		const measured = Object.values(INTERP_RADIUS_CALIBRATION.byRegion)
		expect(INTERP_RADIUS_CALIBRATION.default).toBeGreaterThan(Math.min(...measured))
	})
})
