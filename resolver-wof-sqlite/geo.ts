/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geographic helpers for the resolver — haversine distance + bbox math.
 *
 *   We deliberately don't pull SpatiaLite for this. SQLite's built-in `rtree` virtual table gives us
 *   bbox filtering at the SQL level; haversine distance is a 12-line TS function that's plenty fast
 *   for the post-fetch re-rank pass (we operate on ≤ a few hundred FTS hits per query, not the
 *   whole 142k-row corpus).
 *
 *   The R*Tree index name + schema are centralized in `fts.ts` (alongside the FTS5 build).
 */

const EARTH_RADIUS_KM = 6371

/** WGS-84 degrees → radians. */
function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

/**
 * Great-circle distance between two (lat, lon) points in kilometers.
 *
 * Haversine formula — accurate to ~0.5% over arbitrary distances on Earth. Good enough for a
 * geocoding-ranking score; we'd pick Vincenty if we needed sub-meter accuracy at antipodes.
 */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = toRad(bLat - aLat)
	const dLon = toRad(bLon - aLon)
	const lat1 = toRad(aLat)
	const lat2 = toRad(bLat)

	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Approximate bbox around a point — `radiusKm` in each direction. Used to translate a `near: {lat,
 * lon}` + `maxDistanceKm` filter into an R*Tree bbox query.
 *
 * The math is the spherical-Earth equirectangular approximation: 1° latitude ≈ 111 km globally, 1°
 * longitude ≈ 111 km × cos(latitude). Accurate enough for filtering (we re-check with exact
 * haversine post-fetch), and it stays cheap.
 */
export interface Bbox {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

export function bboxAround(lat: number, lon: number, radiusKm: number): Bbox {
	const latDelta = radiusKm / 111
	// Guard against cos(±90°) = 0 (and tiny values near the poles) by clamping to a minimum.
	const cosLat = Math.max(Math.cos(toRad(lat)), 1e-6)
	const lonDelta = radiusKm / (111 * cosLat)
	return {
		minLat: lat - latDelta,
		maxLat: lat + latDelta,
		minLon: lon - lonDelta,
		maxLon: lon + lonDelta,
	}
}
