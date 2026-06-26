/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinate-format conversions — the pure-math annotators OpenCage exposes (DMS, geohash,
 *   Maidenhead, Web Mercator, qibla bearing). No data, no I/O; each is a deterministic function of
 *   a `{lat, lon}`. {@link coordinateFormatAnnotator} packages them as an `@mailwoman/annotations`
 *   `Annotator`.
 *
 *   MGRS and sun times are deliberately not here yet (MGRS needs full UTM+grid lettering; sun needs
 *   the NOAA solar series) — tracked as a follow-up so this stays a tight, reference-tested set.
 */

import type { AnnotationSet, Annotator } from "@mailwoman/annotations"

const toRad = (d: number): number => (d * Math.PI) / 180
const toDeg = (r: number): number => (r * 180) / Math.PI

/** Render a single signed degree as `D° M′ S″ H` with the given hemisphere letters `[positive,
negative]`. */
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

/** Fill the coordinate-format slice of an {@link AnnotationSet} from a `{lat, lon}`. */
export const coordinateFormatAnnotator: Annotator = ({ lat, lon }): Partial<AnnotationSet> => ({
	dms: toDMS(lat, lon),
	geohash: toGeohash(lat, lon),
	maidenhead: toMaidenhead(lat, lon),
	mercator: toMercator(lat, lon),
	qiblaBearing: qiblaBearing(lat, lon),
})
