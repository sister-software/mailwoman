/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { formatCoordinates, formatDiameter } from "@mailwoman/planetary/features/selected"
import { expect, test } from "vitest"

test("Tycho prints four decimals with hemisphere letters, the longitude east-positive", () => {
	expect(formatCoordinates(-11.3607, -43.2958)).toBe("43.2958° S, 11.3607° W")
})

test("Olympus Mons sits west of the prime meridian in the east-positive convention", () => {
	expect(formatCoordinates(-133.86, 18.65)).toBe("18.6500° N, 133.8600° W")
})

test("the origin takes the positive letters", () => {
	expect(formatCoordinates(0, 0)).toBe("0.0000° N, 0.0000° E")
})

test("a diameter prints in kilometres with a thousands separator, and absence is null", () => {
	expect(formatDiameter(85.29)).toBe("85.29 km")
	expect(formatDiameter(1250)).toBe("1,250 km")
	expect(formatDiameter(undefined)).toBeNull()
})
