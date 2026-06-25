/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { GeoPoint } from "@mailwoman/spatial"
import { expect, test } from "vitest"

// GeoPoint stores GeoJSON [longitude, latitude(, altitude)] order. `from` recognizes several input
// shapes and treats a 0/0 coordinate (Null Island) as a "missing coordinate" sentinel → null.

test("GeoPoint.from: a 2-tuple is read as GeoJSON [longitude, latitude]", () => {
	// coordA = -74 is in [-90, 90] so inferGeoJSONCoordOrder can't disambiguate; it falls through to
	// the default, leaving the pair as-is: longitude = -74, latitude = 40.7.
	const point = GeoPoint.from([-74.006, 40.7128])!

	expect(point).not.toBeNull()
	expect(point.longitude).toBe(-74.006)
	expect(point.latitude).toBe(40.7128)
	expect(point.altitude).toBe(0)
	expect(point.is2D()).toBe(true)
})

test("GeoPoint.from: an out-of-lat-range longitude is recognized as longitude", () => {
	// coordA = -118.24 is outside [-90, 90] → unambiguously the longitude; coordB = 34.05 is latitude.
	const point = GeoPoint.from([-118.2437, 34.0522])!

	expect(point.longitude).toBe(-118.2437)
	expect(point.latitude).toBe(34.0522)
})

test("GeoPoint.from: a 3-tuple is used directly as [longitude, latitude, altitude]", () => {
	const point = GeoPoint.from([-74.006, 40.7128, 125])!

	expect(point.longitude).toBe(-74.006)
	expect(point.latitude).toBe(40.7128)
	expect(point.altitude).toBe(125)
	expect(point.is3D()).toBe(true)
	expect(point.coordinates).toEqual([-74.006, 40.7128, 125])
})

test("GeoPoint.from: a PointLiteral copies coordinates verbatim (no axis inference)", () => {
	const point = GeoPoint.from({ type: "Point", coordinates: [-74.006, 40.7128] })!

	expect(point.type).toBe("Point")
	expect(point.longitude).toBe(-74.006)
	expect(point.latitude).toBe(40.7128)
})

test("GeoPoint.from: a Google Maps LatLngLiteral maps lng→longitude, lat→latitude", () => {
	const point = GeoPoint.from({ lat: 40.7128, lng: -74.006 })!

	expect(point.longitude).toBe(-74.006)
	expect(point.latitude).toBe(40.7128)
})

test("GeoPoint.from: a GeolocationCoordinates-like object carries altitude through", () => {
	const point = GeoPoint.from({ latitude: 48.8566, longitude: 2.3522, altitude: 35 })!

	expect(point.longitude).toBe(2.3522)
	expect(point.latitude).toBe(48.8566)
	expect(point.altitude).toBe(35)
	expect(point.is3D()).toBe(true)
})

test("GeoPoint.from: internal {x, y} coordinates map x→longitude, y→latitude", () => {
	const point = GeoPoint.from({ x: -74.006, y: 40.7128 })!

	expect(point.longitude).toBe(-74.006)
	expect(point.latitude).toBe(40.7128)
	expect(point.altitude).toBe(0)
})

test("GeoPoint.from: a bracketless coordinate string is parsed into a pair", () => {
	// "-74.006,40.7128" isn't valid JSON, so `from` retries as "[-74.006,40.7128]".
	const point = GeoPoint.from("-74.006,40.7128")!

	expect(point).not.toBeNull()
	expect(point.longitude).toBe(-74.006)
	expect(point.latitude).toBe(40.7128)
})

test("GeoPoint.from: a JSON array string is parsed", () => {
	const point = GeoPoint.from("[2.3522, 48.8566]")!

	expect(point.longitude).toBe(2.3522)
	expect(point.latitude).toBe(48.8566)
})

test("GeoPoint.from: an existing GeoPoint is returned unchanged", () => {
	const original = GeoPoint.from([12.4924, 41.8902])!
	const passed = GeoPoint.from(original)

	expect(passed).toBe(original)
})

test("GeoPoint.from: the 0/0 (Null Island) sentinel resolves to null", () => {
	expect(GeoPoint.from([0, 0])).toBeNull()
	expect(GeoPoint.from({ type: "Point", coordinates: [0, 0] })).toBeNull()
	expect(GeoPoint.from({ lat: 0, lng: 0 })).toBeNull()
	expect(GeoPoint.from({ x: 0, y: 0 })).toBeNull()
	expect(GeoPoint.from("0,0")).toBeNull()
})

test("GeoPoint.from: falsy and unparseable input resolves to null", () => {
	expect(GeoPoint.from(null)).toBeNull()
	expect(GeoPoint.from(undefined)).toBeNull()
	expect(GeoPoint.from("")).toBeNull()
	expect(GeoPoint.from(0)).toBeNull()
	// A garbage string that is neither valid JSON nor a wrappable pair falls back to the default 0/0
	// coordinate, which the Null-Island sentinel then rejects.
	expect(GeoPoint.from("not-a-coordinate")).toBeNull()
})

test("GeoPoint.from: a non-zero point that is NOT Null Island survives", () => {
	// Guards against an over-eager sentinel: a real coordinate near, but not at, the origin.
	const point = GeoPoint.from([0.0001, 0.0001])!

	expect(point).not.toBeNull()
	expect(point.isNullIsland()).toBe(false)
})

test("GeoPoint: longitude wraps and latitude clamps on assignment", () => {
	const point = new GeoPoint([0, 0])

	point.longitude = 190 // 190 wraps to -170
	point.latitude = 100 // clamped to the north pole

	expect(point.longitude).toBe(-170)
	expect(point.latitude).toBe(90)
})

test("GeoPoint is iterable, yielding its coordinate tuple", () => {
	const point = GeoPoint.from([-74.006, 40.7128, 5])!

	expect([...point]).toEqual([-74.006, 40.7128, 5])
})

test("GeoPoint.toJSON emits a GeoJSON Point literal", () => {
	const point = GeoPoint.from([-74.006, 40.7128])!

	expect(point.toJSON()).toEqual({ type: "Point", coordinates: [-74.006, 40.7128] })
})
