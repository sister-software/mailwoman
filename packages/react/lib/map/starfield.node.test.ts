/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The star sky's generator and camera math are pure, so they're tested here rather than in the browser suite.
 */

import { describe, expect, test } from "vitest"

import { cameraBasis, generateStarfield, STAR_STRIDE, starColor, unitVector } from "#map/starfield"

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

describe("generateStarfield", () => {
	test("draws the same sky for the same seed and a different one for another", () => {
		const first = generateStarfield({ count: 200, seed: 7 })

		expect(generateStarfield({ count: 200, seed: 7 }).data).toEqual(first.data)
		expect(generateStarfield({ count: 200, seed: 8 }).data).not.toEqual(first.data)
	})

	test("places every star on the unit sphere with a drawable radius and alpha", () => {
		const { count, data } = generateStarfield({ count: 2000 })

		for (let i = 0; i < count; i++) {
			const o = i * STAR_STRIDE
			expect(Math.hypot(data[o]!, data[o + 1]!, data[o + 2]!)).toBeCloseTo(1, 5)
			expect(data[o + 3]).toBeGreaterThan(0)
			expect(data[o + 4]).toBeGreaterThan(0)
			expect(data[o + 4]).toBeLessThanOrEqual(1)
		}
	})

	test("has more faint stars than bright ones", () => {
		const { count, data } = generateStarfield({ count: 5000 })
		const radii = Array.from({ length: count }, (_, i) => data[i * STAR_STRIDE + 3]!)
		const midRange = (Math.min(...radii) + Math.max(...radii)) / 2
		const faint = radii.filter((radius) => radius < midRange).length

		expect(faint).toBeGreaterThan(count - faint)
	})

	test("crowds the band stars toward the galactic plane", () => {
		const pole = unitVector(192.859, 27.128)

		const share = (bandShare: number) => {
			const { count, data } = generateStarfield({ count: 4000, bandShare })
			let near = 0

			for (let i = 0; i < count; i++) {
				const o = i * STAR_STRIDE

				if (Math.abs(dot(pole, [data[o]!, data[o + 1]!, data[o + 2]!])) < Math.sin((15 * Math.PI) / 180)) {
					near++
				}
			}

			return near / count
		}

		expect(share(0.5)).toBeGreaterThan(share(0) + 0.2)
	})
})

describe("cameraBasis", () => {
	test("looks straight down at the center with north up and east right when level", () => {
		const basis = cameraBasis({ lng: 30, lat: 40, bearing: 0, pitch: 0, fov: 36.87 })
		const zenith = unitVector(30, 40)

		expect(dot(basis.forward, zenith)).toBeCloseTo(-1, 6)
		expect(dot(basis.up, unitVector(30, 50))).toBeGreaterThan(0)
		expect(dot(basis.right, unitVector(40, 40))).toBeGreaterThan(dot(basis.right, unitVector(20, 40)))
	})

	test("keeps the axes orthonormal at any bearing and pitch", () => {
		const { right, up, forward } = cameraBasis({ lng: -71, lat: 12, bearing: 137, pitch: 60, fov: 36.87 })

		for (const axis of [right, up, forward]) {
			expect(Math.hypot(...axis)).toBeCloseTo(1, 6)
		}

		expect(dot(right, up)).toBeCloseTo(0, 6)
		expect(dot(up, forward)).toBeCloseTo(0, 6)
		expect(dot(forward, right)).toBeCloseTo(0, 6)
	})
})

describe("starColor", () => {
	test("runs from blue for hot stars to orange for cool ones", () => {
		const [hotRed, , hotBlue] = starColor(-0.3)
		const [coolRed, , coolBlue] = starColor(1.6)

		expect(hotBlue).toBeGreaterThan(hotRed)
		expect(coolRed).toBeGreaterThan(coolBlue)
	})
})
