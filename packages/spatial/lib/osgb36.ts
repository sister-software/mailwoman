/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Coordinates2D } from "#position"

const AIRY_1830_A = 6_377_563.396

const AIRY_1830_B = 6_356_256.909

const GRS80_A = 6_378_137

const GRS80_B = 6_356_752.3141

const NATIONAL_GRID_F0 = 0.9996012717

const NATIONAL_GRID_LAT0 = (49 * Math.PI) / 180

const NATIONAL_GRID_LON0 = (-2 * Math.PI) / 180

const NATIONAL_GRID_E0 = 400_000

const NATIONAL_GRID_N0 = -100_000

const ARCSEC_TO_RAD = Math.PI / (180 * 3600)

const PPM = 1e-6

const MERIDIONAL_ARC_TOLERANCE_M = 1e-5

const GEODETIC_LATITUDE_TOLERANCE_RAD = 1e-13

const OSGB36_TO_WGS84_HELMERT = {
	tx: 446.448,

	ty: -125.157,

	tz: 542.06,

	scalePPM: -20.4894,

	rx: 0.1502,

	ry: 0.247,

	rz: 0.8421,
} as const

/**
 * A geodetic latitude and longitude in degrees on an ellipsoid that the caller must track.
 *
 * The same numbers refer to different places on Airy 1830 and on GRS80.
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
	 * Easting in metres.
	 * Valid GB values run roughly from 0 to 700,000.
	 */
	easting: number

	/**
	 * Northing in metres.
	 * Valid GB values run roughly from 0 to 1,300,000.
	 */
	northing: number
}

/**
 * Converts a National Grid easting and northing to OSGB36 latitude and longitude
 * on the Airy 1830 ellipsoid, without a datum shift.
 *
 * Pass the result to {@link osgb36AiryToWGS84} to get WGS84 coordinates.
 */
export function osgb36GridToAiryLatLon({ easting, northing }: NationalGridPoint): GeodeticLatLon {
	const a = AIRY_1830_A
	const b = AIRY_1830_B
	const f0 = NATIONAL_GRID_F0
	const lat0 = NATIONAL_GRID_LAT0
	const lon0 = NATIONAL_GRID_LON0
	const e0 = NATIONAL_GRID_E0
	const n0 = NATIONAL_GRID_N0

	const e2 = (a * a - b * b) / (a * a)
	const n = (a - b) / (a + b)
	const n2 = n * n
	const n3 = n2 * n

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
 * Converts OSGB36 latitude and longitude on Airy 1830 to WGS84 with the seven-parameter
 * Helmert transform, accurate to about 5 m.
 *
 * The transform ignores height, so use the result for horizontal positions only.
 */
export function osgb36AiryToWGS84({ latitude, longitude }: GeodeticLatLon): GeodeticLatLon {
	const { tx, ty, tz, scalePPM, rx, ry, rz } = OSGB36_TO_WGS84_HELMERT

	const phi = (latitude * Math.PI) / 180
	const lambda = (longitude * Math.PI) / 180
	const sinPhi = Math.sin(phi)
	const cosPhi = Math.cos(phi)
	const e2Airy = (AIRY_1830_A * AIRY_1830_A - AIRY_1830_B * AIRY_1830_B) / (AIRY_1830_A * AIRY_1830_A)
	const nuAiry = AIRY_1830_A / Math.sqrt(1 - e2Airy * sinPhi * sinPhi)

	const x1 = nuAiry * cosPhi * Math.cos(lambda)
	const y1 = nuAiry * cosPhi * Math.sin(lambda)
	const z1 = (1 - e2Airy) * nuAiry * sinPhi

	const s = 1 + scalePPM * PPM
	const rxRad = rx * ARCSEC_TO_RAD
	const ryRad = ry * ARCSEC_TO_RAD
	const rzRad = rz * ARCSEC_TO_RAD

	const x2 = tx + s * x1 - rzRad * y1 + ryRad * z1
	const y2 = ty + rzRad * x1 + s * y1 - rxRad * z1
	const z2 = tz - ryRad * x1 + rxRad * y1 + s * z1

	const e2GRS = (GRS80_A * GRS80_A - GRS80_B * GRS80_B) / (GRS80_A * GRS80_A)
	const p = Math.sqrt(x2 * x2 + y2 * y2)

	let phi2 = Math.atan2(z2, p * (1 - e2GRS))
	let phiPrev = 2 * Math.PI

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
 * Converts a British National Grid (EPSG:27700) easting and northing to WGS84
 * (EPSG:4326) latitude and longitude, accurate to about 5 m across GB.
 *
 * It converts `{ easting: 0, northing: 0 }` like any other point, so callers must
 * filter out Code-Point Open's zero placeholder rows.
 */
export function osgb36ToWGS84(point: NationalGridPoint): GeodeticLatLon {
	return osgb36AiryToWGS84(osgb36GridToAiryLatLon(point))
}

/**
 * Converts a National Grid point to WGS84 in GeoJSON `[longitude, latitude]` order,
 * matching {@link Coordinates2D}.
 */
export function osgb36ToCoordinates2D(point: NationalGridPoint): Coordinates2D {
	const { latitude, longitude } = osgb36ToWGS84(point)

	return [longitude, latitude]
}
