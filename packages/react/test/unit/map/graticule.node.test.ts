/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `buildGraticule` is pure geometry, so it is tested here rather than in the browser suite. What matters is that the
 *   lines are DENSIFIED — a meridian drawn as two endpoints is a straight chord through the sphere under a globe
 *   projection, and would cut across the globe instead of curving over it.
 */

import { buildGraticule } from "@mailwoman/react/map/graticule"
import { describe, expect, test } from "vitest"

describe("buildGraticule", () => {
	const collection = buildGraticule(15)
	const lines = collection.features[0]!.geometry.coordinates

	test("is one MultiLineString feature", () => {
		expect(collection.features).toHaveLength(1)
		expect(collection.features[0]!.geometry.type).toBe("MultiLineString")
	})

	test("draws a meridian every step and a parallel every step", () => {
		// 360/15 = 24 meridians; parallels run from -70 to +80 inclusive of neither pole = 11.
		const meridians = lines.filter((line) => line.every((point) => point[0] === line[0]![0]))
		const parallels = lines.filter((line) => line.every((point) => point[1] === line[0]![1]))

		expect(meridians).toHaveLength(24)
		expect(parallels).toHaveLength(11)
	})

	test("densifies every line, so nothing is a chord through the globe", () => {
		for (const line of lines) {
			expect(line.length).toBeGreaterThan(2)
		}
	})

	test("stays inside Web Mercator's latitude limit", () => {
		for (const line of lines) {
			for (const [, lat] of line) {
				expect(Math.abs(lat!)).toBeLessThanOrEqual(85)
			}
		}
	})

	test("is stable — the same step gives the same geometry", () => {
		expect(buildGraticule(15)).toEqual(collection)
	})
})
