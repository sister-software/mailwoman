/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geographic helpers for the resolver — haversine distance, bbox math, and point-in-polygon.
 *
 *   We deliberately don't pull SpatiaLite (or turf) for this. SQLite's built-in `rtree` virtual table
 *   gives us bbox filtering at the SQL level; haversine distance is a 12-line TS function and
 *   ray-cast PIP a ~30-line one — both plenty fast for the post-fetch passes (we operate on ≤ a few
 *   hundred candidates per query, not the whole 142k-row corpus).
 *
 *   The PIP implementation here is the CANONICAL port of the even-odd ray cast that previously lived
 *   only in Python (`scripts/eval/pip-containment.py`, with a second copy in
 *   `scripts/build-postcode-locality.py`). Keep the three in sync if the algorithm ever changes —
 *   the eval-side Python copies grade the same containment truth this one resolves with.
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

/**
 * A GeoJSON position — `[lon, lat]`, possibly with extra dimensions we ignore. WOF geometries are
 * 2-D throughout, but the type stays open so a 3-D source doesn't break parsing.
 */
export type GeojsonPosition = [number, number, ...number[]]

/** The two areal GeoJSON geometry types PIP can test, plus an open fallback (Point etc.). */
export interface GeojsonPolygon {
	type: "Polygon"
	/** `[outerRing, hole1, hole2, …]` — each ring a closed list of positions. */
	coordinates: GeojsonPosition[][]
}

export interface GeojsonMultiPolygon {
	type: "MultiPolygon"
	coordinates: GeojsonPosition[][][]
}

export type GeojsonGeometry = GeojsonPolygon | GeojsonMultiPolygon | { type: string; coordinates?: unknown }

/**
 * Ray-cast a point against ONE linear ring. Standard even-odd crossing count: shoot a ray along
 * +lon and toggle on every edge crossing. Points exactly on an edge are implementation-defined
 * (either side is acceptable for geocoding — admin boundaries are DP-simplified anyway).
 */
export function pointInRing(lon: number, lat: number, ring: readonly GeojsonPosition[]): boolean {
	let inside = false
	const n = ring.length
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = ring[i]![0]
		const yi = ring[i]![1]
		const xj = ring[j]![0]
		const yj = ring[j]![1]
		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
	}
	return inside
}

/**
 * Even-odd containment over a polygon's ring list (`[outer, hole1, …]`) — being inside an odd
 * number of rings means inside the polygon, which handles holes without ring-orientation rules.
 */
export function pointInPolygonRings(lon: number, lat: number, rings: readonly GeojsonPosition[][]): boolean {
	let inside = false
	for (const ring of rings) {
		if (pointInRing(lon, lat, ring)) inside = !inside
	}
	return inside
}

/**
 * Does an areal GeoJSON geometry contain the point?
 *
 * - `true` / `false` — a Polygon or MultiPolygon was tested.
 * - `null` — the geometry isn't areal (Point, LineString, …) and CANNOT contain; callers treat this
 *   the same as "no polygon on record" (the approximate-fallback path), never as a rejection.
 */
export function geometryContains(
	geometry: GeojsonGeometry | null | undefined,
	lon: number,
	lat: number
): boolean | null {
	if (!geometry) return null
	if (geometry.type === "Polygon") {
		return pointInPolygonRings(lon, lat, (geometry as GeojsonPolygon).coordinates)
	}
	if (geometry.type === "MultiPolygon") {
		return (geometry as GeojsonMultiPolygon).coordinates.some((rings) => pointInPolygonRings(lon, lat, rings))
	}
	return null
}
