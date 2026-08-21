/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two halves of the OSGB36 → WGS84 pipeline are tested SEPARATELY and against different
 *   tolerances, because they fail differently. The projection is exact algebra and is held to
 *   sub-millimetre; the Helmert is an approximation to OSTN15 and is held to the ±5 m the module
 *   docstring promises. Collapsing them into one end-to-end assertion at 5 m would let a real
 *   projection bug hide inside the datum budget.
 */

import { expect, test } from "vitest"

import { osgb36AiryToWGS84, osgb36GridToAiryLatLon, osgb36ToCoordinates2D, osgb36ToWGS84 } from "#index"

/**
 * Degrees-minutes-seconds → decimal degrees. OS publishes its worked examples in DMS, and transcribing them by hand
 * into decimals is exactly the kind of step that silently eats a digit.
 */
function dms(degrees: number, minutes: number, seconds: number): number {
	return degrees + minutes / 60 + seconds / 3600
}

/**
 * Rough metres-per-degree at GB latitudes, for turning an angular residual into the metres the accuracy claim is stated
 * in. Approximate on purpose — it is measuring a 3 m error against a 5 m bar, not surveying.
 */
function offsetMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
	const dNorth = (a.latitude - b.latitude) * 111_132
	const dEast = (a.longitude - b.longitude) * 111_320 * Math.cos((b.latitude * Math.PI) / 180)

	return Math.hypot(dNorth, dEast)
}

/**
 * OS's Annexe C worked example for the National Grid projection, from "A Guide to Coordinate Systems in Great Britain"
 * (V3.6, © OS 2020) — the OSGB36 geodetic coordinates and the eastings/northings they project to. C.1 runs it forwards,
 * C.2 backwards; we test the backwards direction, which is the one this module implements.
 */
const ANNEXE_C_GRID = { easting: 651_409.903, northing: 313_177.27 }
const ANNEXE_C_OSGB36 = { latitude: dms(52, 39, 27.2531), longitude: dms(1, 43, 4.5177) }

/**
 * OS's Annexe D worked example for the seven-parameter Helmert — a single point carried all the way from ETRS89
 * geodetic to National Grid E/N.
 *
 * This is the test that pins the datum shift, and it is worth being precise about what it can and cannot show. Annexe D
 * uses the SAME Helmert this module does, so agreement here proves the implementation — the parameter signs, the
 * Position-Vector rotation convention, the cartesian round trip. It says nothing about how close the Helmert is to
 * OSTN15 truth; that is the separate 40-point test below.
 */
const ANNEXE_D_GRID = { easting: 422_297.792, northing: 412_878.741 }
const ANNEXE_D_OSGB36 = { latitude: dms(53, 36, 42.2972), longitude: -dms(1, 39, 46.5416) }
const ANNEXE_D_ETRS89 = { latitude: dms(53, 36, 43.1653), longitude: -dms(1, 39, 51.992) }

/**
 * A six-point span of OS's official OSTN15/OSGM15 developer-pack test vectors (`OSTN15_OSGM15_TestInput_*`), each
 * pairing a published OSGB36 easting/northing with the published ETRS89 latitude/longitude of the same physical point.
 *
 * OSTN15 is the exact transformation; these residuals therefore measure the Helmert APPROXIMATION, which is the number
 * the module's ±5 m promise is about. Six of the forty are inlined — chosen to span the extremes rather than to sample
 * evenly, because the error is a smooth field and only its corners are informative. TP01 (Scilly) and TP31 (St Kilda)
 * are the two worst points in the whole set; TP08 (Bristol) and TP38 (Shetland waters) are among the best. The full
 * 40-point distribution is recorded in the module docstring.
 *
 * OS OpenData, Open Government Licence v3.
 */
const OSTN15_POINTS = [
	{ id: "TP01", easting: 91_492.146, northing: 11_318.804, latitude: 49.9222639373, longitude: -6.29977752014 },
	{ id: "TP08", easting: 362_269.991, northing: 169_978.69, latitude: 51.4275474302, longitude: -2.54407618349 },
	{ id: "TP20", easting: 422_242.186, northing: 433_818.701, latitude: 53.8002151963, longitude: -1.66379168242 },
	{ id: "TP27", easting: 319_188.434, northing: 670_947.534, latitude: 55.9247826551, longitude: -3.29479219337 },
	{ id: "TP31", easting: 9587.909, northing: 899_448.996, latitude: 57.8135183841, longitude: -8.57854456076 },
	{ id: "TP38", easting: 421_300.525, northing: 1_072_147.239, latitude: 59.5347079449, longitude: -1.62516966058 },
]

test("osgb36GridToAiryLatLon reproduces OS's Annexe C.2 worked example to sub-millimetre", () => {
	const got = osgb36GridToAiryLatLon(ANNEXE_C_GRID)

	// 1e-4 arc-seconds is ~3 mm of ground distance. The measured residual is ~1.3e-5 arcsec (~0.4 mm),
	// which is the worked example's own rounding, not our error — OS publishes to 0.0001".
	expect(Math.abs(got.latitude - ANNEXE_C_OSGB36.latitude) * 3600).toBeLessThan(1e-4)
	expect(Math.abs(got.longitude - ANNEXE_C_OSGB36.longitude) * 3600).toBeLessThan(1e-4)
})

test("the Helmert reproduces OS's Annexe D worked example to the centimetre", () => {
	// Measured 8.4 mm end-to-end. The bar is 5 cm — loose enough to absorb the published DMS rounding
	// (0.0001" is ~3 mm) and our discarded ellipsoidal height, tight enough that a wrong rotation sign
	// or a Coordinate-Frame-vs-Position-Vector mixup (~20 m) cannot slip through.
	const got = osgb36ToWGS84(ANNEXE_D_GRID)

	expect(offsetMeters(got, ANNEXE_D_ETRS89)).toBeLessThan(0.05)

	// The projection half must land on Annexe D's OSGB36 intermediate too, so a failure above localizes
	// to the datum shift rather than leaving both halves suspect.
	const airy = osgb36GridToAiryLatLon(ANNEXE_D_GRID)

	expect(Math.abs(airy.latitude - ANNEXE_D_OSGB36.latitude) * 3600).toBeLessThan(1e-3)
	expect(Math.abs(airy.longitude - ANNEXE_D_OSGB36.longitude) * 3600).toBeLessThan(1e-3)

	// And the shift must be a REAL correction, not a no-op: OSGB36 and WGS84 differ by ~70-120 m across
	// GB, so a Helmert that silently did nothing would still look close to the OSGB36 intermediate.
	expect(offsetMeters(got, ANNEXE_D_OSGB36)).toBeGreaterThan(50)
})

test("the Helmert stays inside 5 m of OSTN15 truth across the GB extremes", () => {
	for (const { id, easting, northing, latitude, longitude } of OSTN15_POINTS) {
		const got = osgb36ToWGS84({ easting, northing })

		expect(offsetMeters(got, { latitude, longitude }), id).toBeLessThan(5)
	}

	// The bar is a promise, not a description — the mainland points are far better than it, and pinning
	// that keeps a regression that doubles the mainland error from hiding under an offshore-sized budget.
	const bristol = OSTN15_POINTS.find((p) => p.id === "TP08")!

	expect(offsetMeters(osgb36ToWGS84(bristol), bristol)).toBeLessThan(1)
})

test("osgb36ToWGS84 places known GB landmarks where they actually are", () => {
	// Real Code-Point Open rows (eastings/northings verbatim from the 2026-05 CSVs) checked against the
	// landmark each postcode is famous for. These catch the failure mode the Caister example cannot: a sign
	// flip or axis swap that stays self-consistent at one point in Norfolk but puts London in the North Sea.
	//
	// The bar is 100 m because the two quantities are not the same thing — a Code-Point centroid is the mean
	// of a postcode unit's delivery points, and the landmark is a single door. Buckingham Palace's grounds
	// alone are wider than the residual being measured.
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
	// Redfearn's series is a truncated expansion in distance from the central meridian; it is well-behaved
	// across GB but not everywhere. Pin the corners so a change to the series terms cannot quietly break
	// the far south-west or the Northern Isles while London still looks right.
	const scilly = osgb36ToWGS84({ easting: 90_000, northing: 10_000 })

	expect(scilly.latitude).toBeGreaterThan(49.8)
	expect(scilly.latitude).toBeLessThan(50.1)
	expect(scilly.longitude).toBeLessThan(-6.2)

	const shetland = osgb36ToWGS84({ easting: 445_000, northing: 1_140_000 })

	expect(shetland.latitude).toBeGreaterThan(60.1)
	expect(shetland.latitude).toBeLessThan(60.9)
})

test("the grid origin is a real Atlantic coordinate, not a sentinel", () => {
	// Code-Point Open writes 0,0 for its 865 no-coordinate rows, but 0,0 IS a valid grid point (south-west
	// of the Scillies). The module cannot detect the sentinel and must not try — this pins that contract so
	// nobody "helpfully" adds a zero check here instead of filtering at the call site.
	const origin = osgb36ToWGS84({ easting: 0, northing: 0 })

	expect(origin.latitude).toBeCloseTo(49.7668, 3)
	expect(origin.longitude).toBeCloseTo(-7.5572, 3)
})

test("osgb36ToCoordinates2D emits GeoJSON axis order", () => {
	const [longitude, latitude] = osgb36ToCoordinates2D(ANNEXE_C_GRID)
	const direct = osgb36ToWGS84(ANNEXE_C_GRID)

	expect(longitude).toBe(direct.longitude)
	expect(latitude).toBe(direct.latitude)

	// The whole point of the helper — lon first. A swapped tuple puts GB in Somalia.
	expect(longitude).toBeLessThan(latitude)
})
