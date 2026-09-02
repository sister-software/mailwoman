/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OSGB36 / British National Grid (EPSG:27700) → WGS84 (EPSG:4326).
 *
 *   Ordnance Survey ships its open products in eastings/northings on the National Grid, not in
 *   degrees — Code-Point Open, OS Open UPRN, OS Open Names all do. Nothing else in the repo speaks
 *   that coordinate system, so this module is the one place that converts it, and it lives in
 *   `@mailwoman/spatial` because that is the math home (`projection.ts` names the datums; this file
 *   moves between two of them).
 *
 *   Two steps, both from OS's own "A Guide to Coordinate Systems in Great Britain":
 *
 *   1. **Inverse transverse Mercator (Redfearn's series)** — National Grid E/N → OSGB36 geodetic
 *      lat/lon on the Airy 1830 ellipsoid. This step is EXACT to well below a millimetre; it is
 *      plain map-projection algebra with no empirical content, and {@link osgb36GridToAiryLatLon}
 *      reproduces the guide's Annexe C.2 worked example to **1.3e-5 arc-seconds (~0.4 mm)**, which
 *      is that example's own published rounding rather than our error.
 *   2. **Seven-parameter Helmert** — Airy-1830 geodetic → geocentric cartesian → rotate/scale/shift
 *      → WGS84 (GRS80) geodetic. This step is APPROXIMATE, and that is the whole accuracy story
 *      below. Against the guide's own Annexe D Helmert worked example — which uses this same
 *      transform, so it tests the implementation and not the approximation — the round trip lands
 *      **8.4 mm** out, i.e. the published DMS rounding plus the ignored ellipsoidal height.
 *
 *   ## Accuracy: ±5 m, measured, and why we accept it
 *
 *   OSGB36 is a 1936 theodolite triangulation, not a geocentric datum. Its distortions relative to
 *   WGS84 are irregular across GB — a couple of metres of local warp that no rigid-body transform can
 *   absorb. OS's exact answer is **OSTN15**, a published ~1.5 MB grid of per-cell E/N shifts; the
 *   seven-parameter Helmert implemented here is OS's own documented approximation to it, which the
 *   guide rates at "up to 3.5 m (95%)".
 *
 *   MEASURED against OS's official 40-point OSTN15/OSGM15 test set (`OSTN15_OSGM15_TestInput_*`, the
 *   developer-pack vectors, joining each point's published OSGB36 E/N to its published ETRS89 lat/lon):
 *
 *   | p50    | p90    | p95    | max    | mean   |
 *   | ------ | ------ | ------ | ------ | ------ |
 *   | 1.74 m | 3.23 m | 4.18 m | 4.91 m | 1.94 m |
 *
 *   All 40 land under 5 m. The worst are exactly where OS warns the datum thins out — TP31 St Kilda
 *   (4.91 m), TP01 Scilly (4.72 m), TP32 Outer Hebrides (4.18 m); the mainland points sit near 1–2 m.
 *   p95 runs a little above the guide's 3.5 m because we discard ellipsoidal height (see
 *   {@link osgb36AiryToWGS84}), and because two of the three worst points are offshore rocks where
 *   "OSGB36 does not exist" in OS's own words.
 *
 *   We take that error deliberately, because of what the coordinates are FOR. A Code-Point Open
 *   centroid is the mean position of a postcode unit's delivery points snapped to the nearest real
 *   address — the unit itself spans tens to hundreds of metres, and the resolver uses the centroid to
 *   pick a locality and rank candidates within a few hundred metres. A 2 m datum error is one to two
 *   orders of magnitude below the quantity being represented. Nothing downstream reads a postcode
 *   centroid at metre precision.
 *
 *   **Do not use this module for anything that does.** Surveying, cadastral work, or any consumer
 *   comparing our coordinates against another OSGB36-derived dataset at sub-10 m tolerance needs
 *   OSTN15, which means shipping the shift grid. If that day comes, the swap point is
 *   {@link osgb36AiryToWGS84} — swap the Helmert for a grid interpolation and the projection step
 *   above it is unchanged.
 *
 *   @see https://www.ordnancesurvey.co.uk/documents/resources/guide-coordinate-systems-great-britain.pdf
 */

import type { Coordinates2D } from "#position"

/**
 * Semi-major axis of the Airy 1830 ellipsoid, in metres — the figure of the Earth OSGB36 is referenced to.
 */
const AIRY_1830_A = 6_377_563.396

/**
 * Semi-minor axis of the Airy 1830 ellipsoid, in metres.
 */
const AIRY_1830_B = 6_356_256.909

/**
 * Semi-major axis of the GRS80 ellipsoid, in metres. WGS84's own semi-major axis is identical; the two ellipsoids
 * differ only in the flattening's last digits (~0.1 mm at the pole), far below this module's error budget.
 */
const GRS80_A = 6_378_137

/**
 * Semi-minor axis of the GRS80 ellipsoid, in metres.
 */
const GRS80_B = 6_356_752.3141

/**
 * Scale factor on the National Grid's central meridian.
 */
const NATIONAL_GRID_F0 = 0.9996012717

/**
 * Latitude of the National Grid's true origin, 49° N, in radians.
 */
const NATIONAL_GRID_LAT0 = (49 * Math.PI) / 180

/**
 * Longitude of the National Grid's true origin, 2° W, in radians.
 */
const NATIONAL_GRID_LON0 = (-2 * Math.PI) / 180

/**
 * Easting of the National Grid's true origin (the "false easting"), in metres.
 */
const NATIONAL_GRID_E0 = 400_000

/**
 * Northing of the National Grid's true origin (the "false northing"), in metres. Negative because the true origin sits
 * south-west of the grid's own zero.
 */
const NATIONAL_GRID_N0 = -100_000

/**
 * Arc-seconds → radians. The Helmert rotations are published in arc-seconds.
 */
const ARCSEC_TO_RAD = Math.PI / (180 * 3600)

/**
 * Parts-per-million → unitless scale. The Helmert scale factor is published in ppm.
 */
const PPM = 1e-6

/**
 * Convergence threshold for the meridional-arc iteration in {@link osgb36GridToAiryLatLon}, in METRES of northing. OS's
 * guide specifies 0.01 mm; this is that figure. It bounds the northing residual, not the latitude, which is why it is
 * expressed in metres and compared against `northing - N0 - M`.
 */
const MERIDIONAL_ARC_TOLERANCE_M = 1e-5

/**
 * Convergence threshold for the cartesian→geodetic latitude iteration in {@link osgb36AiryToWGS84}, in RADIANS. 1e-13
 * rad is ~0.6 µm on the ground — far below anything this module claims, and reached in four or five passes at GB
 * latitudes.
 */
const GEODETIC_LATITUDE_TOLERANCE_RAD = 1e-13

/**
 * The seven-parameter Helmert transformation taking OSGB36 (Airy 1830) geocentric cartesian coordinates to WGS84.
 *
 * OS publishes this transform in the ETRS89/WGS84 → OSGB36 direction (guide table 4), as `tx = -446.448, ty = +125.157,
 * tz = -542.060, s = +20.4894 ppm, rx = -0.1502", ry = -0.2470", rz = -0.8421"`. We need the OTHER direction, so every
 * parameter is negated — valid to well inside the transform's own metre-scale error because the rotations are
 * microradian-scale and the second-order terms of a proper inversion are sub-millimetre.
 *
 * The rotation convention is **Position Vector** (EPSG method 1033), NOT Coordinate Frame Rotation (EPSG 1032). The two
 * differ only in the sign of the three rotations, which is why citing the method code matters more than it looks: paste
 * these numbers into a library expecting 1032 and every result moves by roughly 20 m with no error raised.
 *
 * Getting a sign wrong here does not produce a subtly worse answer; it produces a coordinate tens to hundreds of metres
 * out, in a consistent direction — which reads as a plausible coordinate. That is what the Annexe D test is for.
 */
const OSGB36_TO_WGS84_HELMERT = {
	/**
	 * X translation, metres.
	 */
	tx: 446.448,
	/**
	 * Y translation, metres.
	 */
	ty: -125.157,
	/**
	 * Z translation, metres.
	 */
	tz: 542.06,
	/**
	 * Scale correction, parts per million.
	 */
	scalePPM: -20.4894,
	/**
	 * Rotation about the X axis, arc-seconds.
	 */
	rx: 0.1502,
	/**
	 * Rotation about the Y axis, arc-seconds.
	 */
	ry: 0.247,
	/**
	 * Rotation about the Z axis, arc-seconds.
	 */
	rz: 0.8421,
} as const

/**
 * A geodetic position on an unspecified ellipsoid, in degrees. Which ellipsoid is the caller's business — the whole
 * point of this module is that the same numbers mean different places on Airy 1830 and on GRS80.
 */
export interface GeodeticLatLon {
	/**
	 * Latitude in decimal degrees, positive north.
	 */
	latitude: number
	/**
	 * Longitude in decimal degrees, positive east.
	 */
	longitude: number
}

/**
 * A position on the British National Grid, in metres.
 */
export interface NationalGridPoint {
	/**
	 * Easting in metres. Valid GB values run roughly 0…700,000.
	 */
	easting: number
	/**
	 * Northing in metres. Valid GB values run roughly 0…1,300,000.
	 */
	northing: number
}

/**
 * Convert National Grid eastings/northings to OSGB36 geodetic lat/lon on the Airy 1830 ellipsoid, by Redfearn's inverse
 * transverse Mercator series.
 *
 * This is the EXACT half of the pipeline — pure projection algebra, no datum shift. The result is still on Airy 1830,
 * so it is NOT a WGS84 coordinate and must not be handed to anything expecting one; feed it to
 * {@link osgb36AiryToWGS84}. Exported separately so the projection can be tested against OS's worked example
 * independently of the Helmert, which is the only way to tell a projection bug from a datum-shift bug.
 */
export function osgb36GridToAiryLatLon({ easting, northing }: NationalGridPoint): GeodeticLatLon {
	const a = AIRY_1830_A
	const b = AIRY_1830_B
	const f0 = NATIONAL_GRID_F0
	const lat0 = NATIONAL_GRID_LAT0
	const lon0 = NATIONAL_GRID_LON0
	const e0 = NATIONAL_GRID_E0
	const n0 = NATIONAL_GRID_N0

	// Eccentricity squared of the Airy ellipsoid, and the `n` series parameter.
	const e2 = (a * a - b * b) / (a * a)
	const n = (a - b) / (a + b)
	const n2 = n * n
	const n3 = n2 * n

	// Iterate latitude until the meridional arc `M` matches the northing. OS's guide specifies a 0.01 mm
	// threshold; it converges in three or four passes anywhere in GB.
	let lat = lat0
	let m = 0

	do {
		lat = (northing - n0 - m) / (a * f0) + lat

		const dLat = lat - lat0
		const sLat = lat + lat0

		m =
			b *
			f0 *
			((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * dLat -
				(3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dLat) * Math.cos(sLat) +
				((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat) -
				(35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat))
	} while (Math.abs(northing - n0 - m) >= MERIDIONAL_ARC_TOLERANCE_M)

	const sinLat = Math.sin(lat)
	const cosLat = Math.cos(lat)
	const tanLat = Math.tan(lat)
	const tan2 = tanLat * tanLat
	const tan4 = tan2 * tan2
	const tan6 = tan4 * tan2

	// `nu` = transverse radius of curvature; `rho` = meridional radius; `eta2` = their ratio less one.
	const nu = a * f0 * (1 - e2 * sinLat * sinLat) ** -0.5
	const rho = a * f0 * (1 - e2) * (1 - e2 * sinLat * sinLat) ** -1.5
	const eta2 = nu / rho - 1

	const secLat = 1 / cosLat
	const vii = tanLat / (2 * rho * nu)
	const viii = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2)
	const ix = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4)
	const x = secLat / nu
	const xi = (secLat / (6 * nu ** 3)) * (nu / rho + 2 * tan2)
	const xii = (secLat / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4)
	const xiia = (secLat / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6)

	const dE = easting - e0
	const dE2 = dE * dE
	const dE3 = dE2 * dE
	const dE4 = dE2 * dE2
	const dE5 = dE4 * dE
	const dE6 = dE4 * dE2
	const dE7 = dE6 * dE

	const latitude = lat - vii * dE2 + viii * dE4 - ix * dE6
	const longitude = lon0 + x * dE - xi * dE3 + xii * dE5 - xiia * dE7

	return {
		latitude: (latitude * 180) / Math.PI,
		longitude: (longitude * 180) / Math.PI,
	}
}

/**
 * Convert OSGB36 geodetic lat/lon (Airy 1830) to WGS84 lat/lon (GRS80) via the seven-parameter Helmert.
 *
 * This is the APPROXIMATE half — see the module docstring for the ±5 m budget and when it stops being acceptable.
 * Heights are not modelled: the input is treated as sitting on the Airy ellipsoid and the output's ellipsoidal height
 * is discarded. For a horizontal postcode centroid that costs well under a metre; for anything vertical it is wrong by
 * the ~50 m geoid–ellipsoid separation over GB, so this function does not pretend to return a height.
 */
export function osgb36AiryToWGS84({ latitude, longitude }: GeodeticLatLon): GeodeticLatLon {
	const { tx, ty, tz, scalePPM, rx, ry, rz } = OSGB36_TO_WGS84_HELMERT

	// --- Airy 1830 geodetic → geocentric cartesian.
	const phi = (latitude * Math.PI) / 180
	const lambda = (longitude * Math.PI) / 180
	const sinPhi = Math.sin(phi)
	const cosPhi = Math.cos(phi)
	const e2Airy = (AIRY_1830_A * AIRY_1830_A - AIRY_1830_B * AIRY_1830_B) / (AIRY_1830_A * AIRY_1830_A)
	const nuAiry = AIRY_1830_A / Math.sqrt(1 - e2Airy * sinPhi * sinPhi)

	const x1 = nuAiry * cosPhi * Math.cos(lambda)
	const y1 = nuAiry * cosPhi * Math.sin(lambda)
	const z1 = (1 - e2Airy) * nuAiry * sinPhi

	// --- Helmert: rotate, scale, translate.
	const s = 1 + scalePPM * PPM
	const rxRad = rx * ARCSEC_TO_RAD
	const ryRad = ry * ARCSEC_TO_RAD
	const rzRad = rz * ARCSEC_TO_RAD

	const x2 = tx + s * x1 - rzRad * y1 + ryRad * z1
	const y2 = ty + rzRad * x1 + s * y1 - rxRad * z1
	const z2 = tz - ryRad * x1 + rxRad * y1 + s * z1

	// --- GRS80 geocentric cartesian → geodetic, by the standard iteration on latitude.
	const e2GRS = (GRS80_A * GRS80_A - GRS80_B * GRS80_B) / (GRS80_A * GRS80_A)
	const p = Math.sqrt(x2 * x2 + y2 * y2)

	let phi2 = Math.atan2(z2, p * (1 - e2GRS))
	let phiPrev = 2 * Math.PI

	// Converges in a handful of passes at GB latitudes; the guard bounds it regardless.
	for (let i = 0; i < 100 && Math.abs(phi2 - phiPrev) > GEODETIC_LATITUDE_TOLERANCE_RAD; i++) {
		phiPrev = phi2

		const nuGRS = GRS80_A / Math.sqrt(1 - e2GRS * Math.sin(phi2) * Math.sin(phi2))
		const height = p / Math.cos(phi2) - nuGRS

		phi2 = Math.atan2(z2, p * (1 - (e2GRS * nuGRS) / (nuGRS + height)))
	}

	return {
		latitude: (phi2 * 180) / Math.PI,
		longitude: (Math.atan2(y2, x2) * 180) / Math.PI,
	}
}

/**
 * Convert a British National Grid (EPSG:27700) easting/northing straight to WGS84 (EPSG:4326) lat/lon — the composition
 * of {@link osgb36GridToAiryLatLon} and {@link osgb36AiryToWGS84}, and the function callers actually want.
 *
 * Accurate to about ±5 m across GB (see the module docstring). Does NOT validate that the input lies within the grid's
 * GB extent: `{easting: 0, northing: 0}` is a real point in the Atlantic south-west of the Scillies, and Code-Point
 * Open uses exactly that to mean "no coordinate available" (its 865 positional-quality-90 rows). Callers must filter
 * those rows themselves — a zero here is a legitimate coordinate, so this module cannot tell the difference.
 */
export function osgb36ToWGS84(point: NationalGridPoint): GeodeticLatLon {
	return osgb36AiryToWGS84(osgb36GridToAiryLatLon(point))
}

/**
 * {@link osgb36ToWGS84} in GeoJSON axis order — `[longitude, latitude]`, matching {@link Coordinates2D} and every
 * geometry helper in this package.
 */
export function osgb36ToCoordinates2D(point: NationalGridPoint): Coordinates2D {
	const { latitude, longitude } = osgb36ToWGS84(point)

	return [longitude, latitude]
}
