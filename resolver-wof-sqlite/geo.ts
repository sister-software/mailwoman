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
 *   The even-odd ray cast used to be implemented HERE, with a note asking future readers to keep it
 *   in sync with the Python copies that grade the same containment truth
 *   (`scripts/eval/pip-containment.py`). Hand-maintained sync across copies is the thing that fails
 *   quietly, so the implementation moved to `@mailwoman/spatial` (2026-08-02) and this file
 *   re-exports it — one definition for the resolver, the reverse-geocoder, and the gazetteer
 *   pipeline. The Python side still needs matching by hand; it is the only remaining copy.
 *
 *   The R*Tree index name + schema are centralized in `fts.ts` (alongside the FTS5 build).
 */

import { pointInPolygon } from "@mailwoman/spatial"

// haversineKm and the point-in-polygon ray cast are implemented in @mailwoman/spatial, the math
// home; re-exported so this package's readers keep importing them from "./geo.ts" (the spatial dep
// is transitive via @mailwoman/resolver).
export { haversineKm, pointInRing } from "@mailwoman/spatial"

/**
 * WGS-84 degrees → radians.
 */
function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

/**
 * Approximate bbox around a point — `radiusKm` in each direction. Used to translate a `near: {lat, lon}` +
 * `maxDistanceKm` filter into an R*Tree bbox query.
 *
 * The math is the spherical-Earth equirectangular approximation: 1° latitude ≈ 111 km globally, 1° longitude ≈ 111 km ×
 * cos(latitude). Accurate enough for filtering (we re-check with exact haversine post-fetch), and it stays cheap.
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
 * A GeoJSON position — `[lon, lat]`, possibly with extra dimensions we ignore. WOF geometries are 2-D throughout, but
 * the type stays open so a 3-D source doesn't break parsing.
 */
export type GeojsonPosition = [number, number, ...number[]]

/**
 * The two areal GeoJSON geometry types PIP can test, plus an open fallback (Point etc.).
 */
export interface GeojsonPolygon {
	type: "Polygon"
	/**
	 * `[outerRing, hole1, hole2, …]` — each ring a closed list of positions.
	 */
	coordinates: GeojsonPosition[][]
}

export interface GeojsonMultiPolygon {
	type: "MultiPolygon"
	coordinates: GeojsonPosition[][][]
}

export type GeojsonGeometry = GeojsonPolygon | GeojsonMultiPolygon | { type: string; coordinates?: unknown }

/**
 * Even-odd containment over a polygon's ring list (`[outer, hole1, …]`).
 *
 * Named alias for `@mailwoman/spatial`'s {@link pointInPolygon}, kept because this package's readers and the gazetteer
 * pipeline import `pointInPolygonRings` by name and the "rings" spelling is what makes the ring-list argument obvious
 * at those call sites.
 */
export function pointInPolygonRings(lon: number, lat: number, rings: readonly GeojsonPosition[][]): boolean {
	return pointInPolygon(lon, lat, rings)
}

/**
 * Does an areal GeoJSON geometry contain the point?
 *
 * - `true` / `false` — a Polygon or MultiPolygon was tested.
 * - `null` — the geometry isn't areal (Point, LineString, …) and CANNOT contain; callers treat this the same as "no
 *   polygon on record" (the approximate-fallback path), never as a rejection.
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
