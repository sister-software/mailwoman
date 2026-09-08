/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { BODIES } from "@mailwoman/astrogeology/bodies"
import { expect, test } from "vitest"

// 2πR / 360 on the mean radius: 30,323.4 m for the Moon (R = 1,737.4 km), 59,157.9 m for Mars (R = 3,389.5 km).
test("metres per degree follow the mean radius", () => {
	expect(BODIES.moon.metresPerDegree).toBeCloseTo((2 * Math.PI * 1_737_400) / 360, 6)
	expect(BODIES.mars.metresPerDegree).toBeCloseTo((2 * Math.PI * 3_389_500) / 360, 6)
	expect(Math.round(BODIES.moon.metresPerDegree)).toBe(30_323)
	expect(Math.round(BODIES.mars.metresPerDegree)).toBe(59_158)
})

test("both USGS products carry east longitude in 0..360", () => {
	expect(BODIES.moon.coordinates.longitudeRange).toBe("0..360")
	expect(BODIES.mars.coordinates.longitudeRange).toBe("0..360")
	expect(BODIES.moon.coordinates.longitudeDirection).toBe("east")
	expect(BODIES.mars.coordinates.longitudeDirection).toBe("east")
})
