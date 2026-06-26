/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinate-format conversions — the pure-math annotators OpenCage exposes (DMS, geohash,
 *   Maidenhead, MGRS, Web Mercator, qibla bearing, sun times). No data, no I/O; each is a
 *   deterministic function of a `{lat, lon}`. {@link coordinateFormatAnnotator} packages them as an
 *   `@mailwoman/annotations` `Annotator`.
 */

import type { AnnotationSet, Annotator } from "@mailwoman/annotations"

const toRad = (d: number): number => (d * Math.PI) / 180
const toDeg = (r: number): number => (r * 180) / Math.PI

/**
 * Render a single signed degree as `D° M′ S″ H` with the given hemisphere letters `[positive,
 * negative]`.
 */
function dmsComponent(value: number, hemispheres: [string, string], secondsDp = 2): string {
	const hemisphere = value >= 0 ? hemispheres[0] : hemispheres[1]
	const abs = Math.abs(value)
	const degrees = Math.floor(abs)
	const minutesFull = (abs - degrees) * 60
	const minutes = Math.floor(minutesFull)
	const seconds = (minutesFull - minutes) * 60
	return `${degrees}° ${minutes}′ ${seconds.toFixed(secondsDp)}″ ${hemisphere}`
}

/** Degrees-minutes-seconds for a coordinate. */
export function toDMS(lat: number, lon: number): { lat: string; lon: string } {
	return { lat: dmsComponent(lat, ["N", "S"]), lon: dmsComponent(lon, ["E", "W"]) }
}

const WEB_MERCATOR_R = 6378137

/** Web Mercator (EPSG:3857) projection of a coordinate. */
export function toMercator(lat: number, lon: number): { x: number; y: number } {
	const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat))
	return {
		x: WEB_MERCATOR_R * toRad(lon),
		y: WEB_MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + toRad(clampedLat) / 2)),
	}
}

const KAABA = { lat: 21.4225, lon: 39.8262 }

/** Initial great-circle bearing (degrees from true north) from a coordinate toward the Kaaba. */
export function qiblaBearing(lat: number, lon: number): number {
	const phi1 = toRad(lat)
	const phi2 = toRad(KAABA.lat)
	const dLon = toRad(KAABA.lon - lon)
	const y = Math.sin(dLon)
	const x = Math.cos(phi1) * Math.tan(phi2) - Math.sin(phi1) * Math.cos(dLon)
	return (toDeg(Math.atan2(y, x)) + 360) % 360
}

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

/** Encode a coordinate as a geohash of the given precision (default 9 ≈ 4.8 m). */
export function toGeohash(lat: number, lon: number, precision = 9): string {
	let latMin = -90
	let latMax = 90
	let lonMin = -180
	let lonMax = 180
	let hash = ""
	let bits = 0
	let bit = 0
	let evenBit = true

	while (hash.length < precision) {
		if (evenBit) {
			const mid = (lonMin + lonMax) / 2
			if (lon >= mid) {
				bits = bits * 2 + 1
				lonMin = mid
			} else {
				bits *= 2
				lonMax = mid
			}
		} else {
			const mid = (latMin + latMax) / 2
			if (lat >= mid) {
				bits = bits * 2 + 1
				latMin = mid
			} else {
				bits *= 2
				latMax = mid
			}
		}
		evenBit = !evenBit
		if (++bit === 5) {
			hash += GEOHASH_BASE32[bits]
			bit = 0
			bits = 0
		}
	}
	return hash
}

const A_CODE = "A".charCodeAt(0)

/** Maidenhead grid locator (default 6-char: field uppercase, square digits, subsquare lowercase). */
export function toMaidenhead(lat: number, lon: number, pairs = 3): string {
	const lonAdj = lon + 180
	const latAdj = lat + 90
	const out = [
		String.fromCharCode(A_CODE + Math.floor(lonAdj / 20)),
		String.fromCharCode(A_CODE + Math.floor(latAdj / 10)),
		String(Math.floor((lonAdj % 20) / 2)),
		String(Math.floor(latAdj % 10)),
		String.fromCharCode(A_CODE + Math.floor((lonAdj % 2) * 12)).toLowerCase(),
		String.fromCharCode(A_CODE + Math.floor((latAdj % 1) * 24)).toLowerCase(),
	]
	return out.slice(0, pairs * 2).join("")
}

const J2000 = 2451545.0
const unixEpochJulian = 2440587.5

/**
 * Sunrise / solar-noon / sunset for a coordinate on a date, as UTC epoch seconds, via the standard
 * sunrise equation. `rise` and `set` are absent during polar day or polar night (the sun never
 * crosses the horizon); `noon` (solar transit) is always present.
 */
export function sunTimes(
	lat: number,
	lon: number,
	date: Date = new Date()
): { rise?: number; set?: number; noon: number } {
	const julian = date.getTime() / 86400000 + unixEpochJulian
	const n = Math.round(julian - J2000 - 0.0009 + lon / 360)
	const meanSolarTime = n + 0.0009 - lon / 360
	const M = (357.5291 + 0.98560028 * meanSolarTime) % 360
	const Mr = toRad(M)
	const center = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr)
	const lambda = toRad((M + center + 180 + 102.9372) % 360)
	const transit = J2000 + meanSolarTime + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lambda)
	const declination = Math.asin(Math.sin(lambda) * Math.sin(toRad(23.4397)))
	const latR = toRad(lat)
	const cosH =
		(Math.sin(toRad(-0.833)) - Math.sin(latR) * Math.sin(declination)) / (Math.cos(latR) * Math.cos(declination))
	const toEpoch = (j: number): number => Math.round((j - unixEpochJulian) * 86400)
	const noon = toEpoch(transit)
	if (cosH >= 1 || cosH <= -1) return { noon }
	const hourAngle = toDeg(Math.acos(cosH))
	return { rise: toEpoch(transit - hourAngle / 360), set: toEpoch(transit + hourAngle / 360), noon }
}

// MGRS / UTM (WGS84). The forward Transverse Mercator series + the military grid lettering.
const UTM_A = 6378137.0
const UTM_F = 1 / 298.257223563
const UTM_K0 = 0.9996
const UTM_E2 = UTM_F * (2 - UTM_F)
const UTM_EP2 = UTM_E2 / (1 - UTM_E2)

function latLonToUtm(lat: number, lon: number): { zone: number; easting: number; northing: number } {
	const zone = Math.floor((lon + 180) / 6) + 1
	const lon0 = toRad((zone - 1) * 6 - 180 + 3)
	const phi = toRad(lat)
	const N = UTM_A / Math.sqrt(1 - UTM_E2 * Math.sin(phi) ** 2)
	const T = Math.tan(phi) ** 2
	const C = UTM_EP2 * Math.cos(phi) ** 2
	const A = Math.cos(phi) * (toRad(lon) - lon0)
	const M =
		UTM_A *
		((1 - UTM_E2 / 4 - (3 * UTM_E2 ** 2) / 64 - (5 * UTM_E2 ** 3) / 256) * phi -
			((3 * UTM_E2) / 8 + (3 * UTM_E2 ** 2) / 32 + (45 * UTM_E2 ** 3) / 1024) * Math.sin(2 * phi) +
			((15 * UTM_E2 ** 2) / 256 + (45 * UTM_E2 ** 3) / 1024) * Math.sin(4 * phi) -
			((35 * UTM_E2 ** 3) / 3072) * Math.sin(6 * phi))
	const easting =
		UTM_K0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * UTM_EP2) * A ** 5) / 120) +
		500000
	let northing =
		UTM_K0 *
		(M +
			N *
				Math.tan(phi) *
				(A ** 2 / 2 +
					((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
					((61 - 58 * T + T ** 2 + 600 * C - 330 * UTM_EP2) * A ** 6) / 720))
	if (lat < 0) northing += 10000000
	return { zone, easting, northing }
}

const MGRS_LAT_BANDS = "CDEFGHJKLMNPQRSTUVWX"
const MGRS_COL_SETS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"]
const MGRS_ROW_LETTERS = "ABCDEFGHJKLMNPQRSTUV"

/** Military Grid Reference System for a coordinate (`"18SUJ2340806479"`); `""` outside MGRS bands
(±80°/84°). */
export function toMGRS(lat: number, lon: number): string {
	if (lat < -80 || lat > 84) return ""
	const band = MGRS_LAT_BANDS[Math.floor((lat + 80) / 8)]!
	const { zone, easting, northing } = latLonToUtm(lat, lon)
	const colLetter = MGRS_COL_SETS[(zone - 1) % 3]![Math.floor(easting / 100000) - 1]!
	let row = Math.floor(northing / 100000) % 20
	if (zone % 2 === 0) row = (row + 5) % 20
	const rowLetter = MGRS_ROW_LETTERS[row]!
	const e = String(Math.floor(easting % 100000)).padStart(5, "0")
	const n = String(Math.floor(northing % 100000)).padStart(5, "0")
	return `${zone}${band}${colLetter}${rowLetter}${e}${n}`
}

/** Fill the coordinate-format slice of an {@link AnnotationSet} from a `{lat, lon}`. */
export const coordinateFormatAnnotator: Annotator = ({ lat, lon, date }): Partial<AnnotationSet> => ({
	dms: toDMS(lat, lon),
	geohash: toGeohash(lat, lon),
	maidenhead: toMaidenhead(lat, lon),
	mgrs: toMGRS(lat, lon) || undefined,
	mercator: toMercator(lat, lon),
	qiblaBearing: qiblaBearing(lat, lon),
	sun: sunTimes(lat, lon, date),
})
