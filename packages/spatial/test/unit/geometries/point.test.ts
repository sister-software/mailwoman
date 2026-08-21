/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { GeoPoint } from "#index"

// GeoPoint stores GeoJSON [longitude, latitude(, altitude)] order. `from` recognizes several input
// shapes and treats a 0/0 coordinate (Null Island) as a "missing coordinate" sentinel → null.

test("GeoPoint.from: a 2-tuple is read as GeoJSON [longitude, latitude]", () => {
	const point = GeoPoint.from([-74.006, 40.7128])!

	expect(point).not.toBeNull()
	expect(point.longitude).toBe(-74.006)
	expect(point.latitude).toBe(40.7128)
	expect(point.altitude).toBe(0)
	expect(point.is2D()).toBe(true)
})

test("GeoPoint.from: an out-of-lat-range longitude is still just the longitude", () => {
	const point = GeoPoint.from([-118.2437, 34.0522])!

	expect(point.longitude).toBe(-118.2437)
	expect(point.latitude).toBe(34.0522)
})

// The axis order is FIXED, not inferred. Until 2026-08-05 the constructor ran a 2-tuple through
// `inferGeoJSONCoordOrder`, which transposes the pair when the first magnitude is in [-90, 90] and
// the second is not. That fires on a [latitude, longitude] pair only where |longitude| > 90 — the
// Americas and the Pacific — so the SAME caller mistake was silently repaired in Dallas and silently
// kept in Berlin. A contract that depends on which continent the data is from is not a contract.
test("GeoPoint.from: a [latitude, longitude] pair is never silently transposed, on any continent", () => {
	// Berlin written lat-first. The literal GeoJSON reading is 52.52°E 13.4°N — the Arabian Sea. The
	// old heuristic returned exactly this too (both magnitudes ≤ 90, so it declined to guess).
	const berlin = GeoPoint.from([52.52, 13.405])!

	expect(berlin.longitude).toBe(52.52)
	expect(berlin.latitude).toBe(13.405)

	// Dallas written lat-first. The old heuristic REPAIRED this one to [-96.797, 32.7767]. The literal
	// reading puts latitude at -96.797, which is off the globe, so it is now rejected outright.
	expect(GeoPoint.from([32.7767, -96.797])).toBeNull()
})

test("GeoPoint.from: an out-of-range magnitude is rejected, not clamped or wrapped", () => {
	expect(GeoPoint.from([999, 999])).toBeNull()
	expect(GeoPoint.from([0, 91])).toBeNull() // latitude just past the pole
	expect(GeoPoint.from([181, 0])).toBeNull() // longitude just past the antimeridian
	expect(GeoPoint.from("200,100")).toBeNull()
	expect(GeoPoint.from({ type: "Point", coordinates: [0, -90.5] })).toBeNull()
	expect(GeoPoint.from({ lat: 91, lng: 0 })).toBeNull()
	expect(GeoPoint.from({ x: 181, y: 0 })).toBeNull()
	expect(GeoPoint.from({ latitude: 91, longitude: 0, altitude: 0 })).toBeNull()
	// The poles and the antimeridian themselves are IN range.
	expect(GeoPoint.from([180, 90])).not.toBeNull()
	expect(GeoPoint.from([-180, -90])).not.toBeNull()
})

test("GeoPoint: the constructor throws on an out-of-range coordinate", () => {
	expect(() => new GeoPoint([0, 91])).toThrow(RangeError)
	expect(() => new GeoPoint([181, 0])).toThrow(RangeError)
	expect(() => new GeoPoint([Number.NaN, 0])).toThrow(RangeError)
})

// The compatibility receipt for dropping the inference: for a pair that is ACTUALLY valid GeoJSON,
// the heuristic was already a no-op in every case. It transposes only when the second magnitude is
// outside [-90, 90] — i.e. when the pair claims a latitude off the globe — so no well-formed input
// changes meaning. These cover all four longitude bands and both hemispheres.
test("GeoPoint.from: every valid GeoJSON pair reads back unchanged", () => {
	const cities: Array<[name: string, lon: number, lat: number]> = [
		["Berlin", 13.405, 52.52],
		["Lagos", 3.3792, 6.5244],
		["Cape Town", 18.4241, -33.9249],
		["Reykjavík", -21.9426, 64.1466],
		["Los Angeles", -118.2437, 34.0522],
		["Buenos Aires", -58.3816, -34.6037],
		["Tokyo", 139.6917, 35.6895],
		["Auckland", 174.7633, -36.8485],
	]

	for (const [name, lon, lat] of cities) {
		const point = GeoPoint.from([lon, lat])

		expect(point, name).not.toBeNull()
		expect(point!.longitude, name).toBe(lon)
		expect(point!.latitude, name).toBe(lat)
	}
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
