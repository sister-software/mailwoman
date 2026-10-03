/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The projection and the Helmert are tested separately and against different tolerances, because
 *   they fail differently.
 */

import { expect, test } from "vitest"

import { osgb36GridToAiryLatLon, osgb36ToCoordinates2D, osgb36ToWGS84 } from "#index"

function dms(degrees: number, minutes: number, seconds: number): number {
	return degrees + minutes / 60 + seconds / 3600
}

/**
 * Rough meters-per-degree at GB latitudes, for turning an angular residual into
 * the meters the accuracy claim is stated in.
 */
function offsetMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
	const dNorth = (a.latitude - b.latitude) * 111_132
	const dEast = (a.longitude - b.longitude) * 111_320 * Math.cos((b.latitude * Math.PI) / 180)

	return Math.hypot(dNorth, dEast)
}

/**
 * OS's Annexe C worked example for the National Grid projection, giving the eastings/northings
 * and the OSGB36 geodetic coordinates they project to (V3.6, © OS 2020).
 */
const ANNEXE_C_GRID = { easting: 651_409.903, northing: 313_177.27 }
const ANNEXE_C_OSGB36 = { latitude: dms(52, 39, 27.2531), longitude: dms(1, 43, 4.5177) }

/**
 * OS's Annexe D worked example for the seven-parameter Helmert, converted from
 * ETRS89 geodetic to National Grid E/N.
 * This pins the datum shift.
 */
const ANNEXE_D_GRID = { easting: 422_297.792, northing: 412_878.741 }
const ANNEXE_D_OSGB36 = { latitude: dms(53, 36, 42.2972), longitude: -dms(1, 39, 46.5416) }
const ANNEXE_D_ETRS89 = { latitude: dms(53, 36, 43.1653), longitude: -dms(1, 39, 51.992) }

/**
 * Six of OS's forty official OSTN15/OSGM15 developer-pack test vectors, chosen to span the
 * extremes rather than sample evenly, under OS OpenData, Open Government Licence v3.
 */
const OSTN15_POINTS = [
	{ id: "TP01", easting: 91_492.146, northing: 11_318.804, latitude: 49.9222639373, longitude: -6.29977752014 },
	{ id: "TP08", easting: 362_269.991, northing: 169_978.69, latitude: 51.4275474302, longitude: -2.54407618349 },
	{ id: "TP20", easting: 422_242.186, northing: 433_818.701, latitude: 53.8002151963, longitude: -1.66379168242 },
	{ id: "TP27", easting: 319_188.434, northing: 670_947.534, latitude: 55.9247826551, longitude: -3.29479219337 },
	{ id: "TP31", easting: 9587.909, northing: 899_448.996, latitude: 57.8135183841, longitude: -8.57854456076 },
	{ id: "TP38", easting: 421_300.525, northing: 1_072_147.239, latitude: 59.5347079449, longitude: -1.62516966058 },
]

test("osgb36GridToAiryLatLon reproduces OS's Annexe C.2 worked example to sub-millimeter", () => {
	const got = osgb36GridToAiryLatLon(ANNEXE_C_GRID)

	// 1e-4 arc-seconds is ~3 mm of ground distance, matching the worked example's own published rounding.
	expect(Math.abs(got.latitude - ANNEXE_C_OSGB36.latitude) * 3600).toBeLessThan(1e-4)
	expect(Math.abs(got.longitude - ANNEXE_C_OSGB36.longitude) * 3600).toBeLessThan(1e-4)
})

test("the Helmert reproduces OS's Annexe D worked example to the centimeter", () => {
	// The bar is 5 cm — loose enough to absorb the published DMS rounding and our discarded
	// ellipsoidal height, tight enough that a wrong rotation sign cannot slip through.
	const got = osgb36ToWGS84(ANNEXE_D_GRID)

	expect(offsetMeters(got, ANNEXE_D_ETRS89)).toBeLessThan(0.05)

	const airy = osgb36GridToAiryLatLon(ANNEXE_D_GRID)

	expect(Math.abs(airy.latitude - ANNEXE_D_OSGB36.latitude) * 3600).toBeLessThan(1e-3)
	expect(Math.abs(airy.longitude - ANNEXE_D_OSGB36.longitude) * 3600).toBeLessThan(1e-3)

	// OSGB36 and WGS84 differ by ~70-120 m across GB, so a Helmert that left the coordinate
	// unchanged would still look close to the OSGB36 intermediate.
	expect(offsetMeters(got, ANNEXE_D_OSGB36)).toBeGreaterThan(50)
})

test("the Helmert stays inside 5 m of OSTN15 truth across the GB extremes", () => {
	for (const { id, easting, northing, latitude, longitude } of OSTN15_POINTS) {
		const got = osgb36ToWGS84({ easting, northing })

		expect(offsetMeters(got, { latitude, longitude }), id).toBeLessThan(5)
	}

	// The mainland residual catches regressions that an offshore-sized budget could hide.
	const bristol = OSTN15_POINTS.find((p) => p.id === "TP08")!

	expect(offsetMeters(osgb36ToWGS84(bristol), bristol)).toBeLessThan(1)
})

test("osgb36ToWGS84 places known GB landmarks where they actually are", () => {
	// The bar is 100 m because a Code-Point centroid is the mean of a postcode unit's
	// delivery points while the landmark is a single door.
	const cases = [
		{ name: "SW1A 1AA (Buckingham Palace)", grid: { easting: 529_090, northing: 179_645 }, lat: 51.5014, lon: -0.1419 },
		{ name: "SW1A 2AA (10 Downing Street)", grid: { easting: 530_047, northing: 179_951 }, lat: 51.5034, lon: -0.1276 },
		{
			name: "EH99 1SP (Scottish Parliament)",
			grid: { easting: 326_751, northing: 673_849 },
			lat: 55.9522,
			lon: -3.1745,
		},
	]

	for (const { name, grid, lat, lon } of cases) {
		const got = osgb36ToWGS84(grid)

		expect(offsetMeters(got, { latitude: lat, longitude: lon }), name).toBeLessThan(100)
	}
})

test("osgb36ToWGS84 spans the GB extent without the series diverging", () => {
	// Redfearn's series is a truncated expansion in distance from the central meridian,
	// so pin the corners as well as London.
	const scilly = osgb36ToWGS84({ easting: 90_000, northing: 10_000 })

	expect(scilly.latitude).toBeGreaterThan(49.8)
	expect(scilly.latitude).toBeLessThan(50.1)
	expect(scilly.longitude).toBeLessThan(-6.2)

	const shetland = osgb36ToWGS84({ easting: 445_000, northing: 1_140_000 })

	expect(shetland.latitude).toBeGreaterThan(60.1)
	expect(shetland.latitude).toBeLessThan(60.9)
})

test("the grid origin is a real Atlantic coordinate, not a sentinel", () => {
	// Code-Point Open writes 0,0 for its no-coordinate rows, but 0,0 is a valid grid
	// point the module must not treat as a sentinel.
	const origin = osgb36ToWGS84({ easting: 0, northing: 0 })

	expect(origin.latitude).toBeCloseTo(49.7668, 3)
	expect(origin.longitude).toBeCloseTo(-7.5572, 3)
})

test("osgb36ToCoordinates2D emits GeoJSON axis order", () => {
	const [longitude, latitude] = osgb36ToCoordinates2D(ANNEXE_C_GRID)
	const direct = osgb36ToWGS84(ANNEXE_C_GRID)

	expect(longitude).toBe(direct.longitude)
	expect(latitude).toBe(direct.latitude)

	// The whole point of the helper — lon first, since a swapped tuple puts GB in Somalia.
	expect(longitude).toBeLessThan(latitude)
})
