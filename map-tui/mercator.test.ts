/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { lonLatToWorldPx, metersPerPixel, TILE_SIZE, worldPxToLonLat } from "./mercator.ts"

describe("lonLatToWorldPx", () => {
	it("maps the origin to the center of the world plane", () => {
		const { x, y } = lonLatToWorldPx(0, 0, 0)
		expect(x).toBeCloseTo(TILE_SIZE / 2, 6)
		expect(y).toBeCloseTo(TILE_SIZE / 2, 6)
	})

	it("round-trips Portland at z15", () => {
		const px = lonLatToWorldPx(-122.6023, 45.5034, 15)
		const back = worldPxToLonLat(px.x, px.y, 15)
		expect(back.lon).toBeCloseTo(-122.6023, 6)
		expect(back.lat).toBeCloseTo(45.5034, 6)
	})

	it("doubles pixel coordinates per zoom step", () => {
		const z3 = lonLatToWorldPx(-122.6, 45.5, 3)
		const z4 = lonLatToWorldPx(-122.6, 45.5, 4)
		expect(z4.x).toBeCloseTo(z3.x * 2, 6)
		expect(z4.y).toBeCloseTo(z3.y * 2, 6)
	})
})

describe("metersPerPixel", () => {
	it("matches the equatorial ground resolution at z0", () => {
		// 40,075,016.686 m circumference / 256 px
		expect(metersPerPixel(0, 0)).toBeCloseTo(156_543.03392, 2)
	})

	it("shrinks with cos(lat)", () => {
		expect(metersPerPixel(60, 10) / metersPerPixel(0, 10)).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 6)
	})
})
