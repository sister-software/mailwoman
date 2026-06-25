/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { parseTileCoordParams, pointToTile, pointToTileFraction } from "./coords.js"

// Web Mercator slippy-map math: at zoom z there are z2 = 2^z tiles per axis. The X fraction is
// z2·(lon/360 + 0.5), wrapped into [0, z2). The Y fraction is z2·(0.5 − ln((1+sin)/(1−sin))/(4π)),
// which sends lat = 0 to the vertical centre and the ±85.0511° clip latitudes to 0 and z2.
const MERCATOR_CLIP_LAT = 85.05112877980659

//#region pointToTileFraction — X axis

test("pointToTileFraction: lon −180 is the left edge (x = 0)", () => {
	expect(pointToTileFraction(0, -180, 0)).toEqual([0, 0, 0.5])
	expect(pointToTileFraction(2, -180, 0)[1]).toBe(0)
})

test("pointToTileFraction: lon 0 sits at the horizontal centre (x = z2/2)", () => {
	expect(pointToTileFraction(0, 0, 0)[1]).toBe(0.5) // z2 = 1 → centre 0.5
	expect(pointToTileFraction(2, 0, 0)[1]).toBe(2) // z2 = 4 → centre 2
	expect(pointToTileFraction(10, 0, 0)[1]).toBe(512) // z2 = 1024 → centre 512
})

test("pointToTileFraction: lon +180 wraps back onto the left edge (x = 0)", () => {
	// z2·(180/360 + 0.5) = z2, and z2 % z2 = 0 — the antimeridian wraps to the same column as −180.
	expect(pointToTileFraction(0, 180, 0)[1]).toBe(0)
	expect(pointToTileFraction(3, 180, 0)[1]).toBe(0)
})

test("pointToTileFraction: ±90° longitude land on the quarter columns", () => {
	// z2 = 4: +90 → 4·0.75 = 3, −90 → 4·0.25 = 1.
	expect(pointToTileFraction(2, 90, 0)[1]).toBe(3)
	expect(pointToTileFraction(2, -90, 0)[1]).toBe(1)
})

test("pointToTileFraction: longitudes past +180 wrap into range rather than overflow", () => {
	// 270° == −90° on the globe; both must produce x = 1 at zoom 2 after the modulo wrap.
	expect(pointToTileFraction(2, 270, 0)[1]).toBe(1)
	expect(pointToTileFraction(2, -90, 0)[1]).toBe(1)
})

//#endregion

//#region pointToTileFraction — Y axis

test("pointToTileFraction: the equator sits at the vertical centre (y = z2/2)", () => {
	expect(pointToTileFraction(0, 0, 0)[2]).toBe(0.5)
	expect(pointToTileFraction(2, 0, 0)[2]).toBe(2)
})

test("pointToTileFraction: the Mercator clip latitudes map to the top and bottom edges", () => {
	// +85.0511° → y ≈ 0 (top), −85.0511° → y ≈ z2 (bottom). The projection's vertical extent.
	expect(pointToTileFraction(0, 0, MERCATOR_CLIP_LAT)[2]).toBeCloseTo(0, 12)
	expect(pointToTileFraction(0, 0, -MERCATOR_CLIP_LAT)[2]).toBeCloseTo(1, 12)
})

test("pointToTileFraction: northern latitudes sit above centre, southern below", () => {
	const north = pointToTileFraction(1, 0, 45)[2]
	const south = pointToTileFraction(1, 0, -45)[2]

	expect(north).toBeLessThan(1) // above the z2 = 2 centre
	expect(south).toBeGreaterThan(1) // below it
	// Mercator is symmetric about the equator.
	expect(north + south).toBeCloseTo(2, 12)
	expect(north).toBeCloseTo(0.7194500738304099, 12)
})

test("pointToTileFraction: passes the zoom through unchanged", () => {
	expect(pointToTileFraction(7, 12.5, 41.9)[0]).toBe(7)
})

//#endregion

//#region pointToTile

test("pointToTile: floors the fractional tile to integer tile indices", () => {
	// San Francisco (−122.4194, 37.7749) at zoom 12 → tile (655, 1583) in standard slippy-map space.
	expect(pointToTile(12, -122.4194, 37.7749)).toEqual([12, 655, 1583])
})

test("pointToTile: zoom 0 has exactly one tile (0, 0)", () => {
	expect(pointToTile(0, 0, 0)).toEqual([0, 0, 0])
	// 84° is comfortably inside the +85.0511° clip, so the single tile is unambiguously (0, 0).
	expect(pointToTile(0, -180, 84)).toEqual([0, 0, 0])
})

test("pointToTile: the top-left corner of the world is tile (0, 0)", () => {
	// −180 lon (left edge), a high northern latitude → the north-west corner → tile (0, 0) at any zoom.
	expect(pointToTile(5, -180, 84)).toEqual([5, 0, 0])
})

test("pointToTile: the exact Mercator clip latitude floors to tile y = −1 (no clamping)", () => {
	// At precisely +85.0511° the Y fraction is ~ −7.8e-16: a floating-point hair below 0. Because
	// pointToTile floors without clamping y into [0, z2), the boundary lands on tile −1, not 0.
	// Callers that feed the exact clip latitude must clamp themselves; we pin the behaviour so a
	// future clamp shows up as a deliberate change here.
	expect(pointToTileFraction(0, 0, MERCATOR_CLIP_LAT)[2]).toBeLessThan(0)
	expect(pointToTile(0, 0, MERCATOR_CLIP_LAT)).toEqual([0, 0, -1])
})

//#endregion

//#region parseTileCoordParams

test("parseTileCoordParams: parses a well-formed {z, x, y} into a numeric tuple", () => {
	expect(parseTileCoordParams({ z: "12", x: "655", y: "1583" })).toEqual([12, 655, 1583])
})

test("parseTileCoordParams: returns null when a component is missing or non-numeric", () => {
	expect(parseTileCoordParams({ z: "12", x: "655" })).toBeNull() // y absent → NaN filtered out
	expect(parseTileCoordParams({ z: "12", x: "abc", y: "1583" })).toBeNull()
	expect(parseTileCoordParams({})).toBeNull()
})

//#endregion
