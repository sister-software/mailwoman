/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { GeometryLiteral } from "#geometries/collection"
import type { LineStringPath } from "#geometries/line-string"
import type { GeoObjectLiteral } from "#objects"

/**
 * An array of positions forming a closed shape, such as a country or a lake.
 */
export type SolidPolygonPath = [
	/**
	 * A linear ring is a closed LineString with four or more positions.
	 */
	exteriorRing: LineStringPath,
]

/**
 * An array of positions forming a closed shape with holes, such as a country
 * with islands or a lake with islands.
 */
export type NestedPolygonPath = [
	/**
	 * A linear ring is a closed LineString with four or more positions.
	 */
	exteriorRing: LineStringPath,
	...interiorRings: LineStringPath[],
]

/**
 * A polygon geometry.
 */
export type PolygonPath = SolidPolygonPath | NestedPolygonPath

/**
 * An array of positions forming a closed shape, such as a country or a lake.
 */
export interface PolygonLiteral<P extends PolygonPath = PolygonPath> extends GeoObjectLiteral {
	type: "Polygon"
	coordinates: P
}

/**
 * Predicate for checking if a GeoJSON object is a `Polygon` geometry.
 */
export function isPolygonLiteral<P extends PolygonPath = PolygonPath>(input: unknown): input is PolygonLiteral<P> {
	if (typeof input !== "object" || input === null) return false

	return "type" in input && input.type === "Polygon" && "coordinates" in input && Array.isArray(input.coordinates)
}

/**
 * Predicate for checking if a polygon geometry is a solid, i.e. it has no holes.
 */
// The parameter admits both paths because distinguishing them is the function's job.
export function isSolidPolygonPath(input: PolygonLiteral<PolygonPath>): boolean {
	return input.coordinates.length === 1
}

/**
 * A linear ring as the containment predicates read it, deliberately looser than
 * {@link LineStringPath} because callers arrive with different position types.
 */
export type ContainmentRing = readonly (readonly number[])[]

/**
 * One polygon's rings: `[exterior, ...holes]`.
 */
export type PolygonRings = readonly ContainmentRing[]

/**
 * A feature's polygons — `MultiPolygon` coordinates, with a bare `Polygon` lifted
 * into the same shape by {@linkcode arealPolygons}.
 */
export type MultiPolygonRings = readonly PolygonRings[]

/**
 * Ray-cast a point against one linear ring — the even-odd crossing count, with
 * points exactly on an edge left implementation-defined.
 */
export function pointInRing(lon: number, lat: number, ring: ContainmentRing): boolean {
	let inside = false
	const n = ring.length

	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = ring[i]![0]!
		const yi = ring[i]![1]!
		const xj = ring[j]![0]!
		const yj = ring[j]![1]!

		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
	}

	return inside
}

/**
 * Even-odd containment over a polygon's ring list (`[outer, hole₁, …]`), independent
 * of ring winding order because the gazetteer sources do not honour it reliably.
 */
export function pointInPolygon(lon: number, lat: number, rings: PolygonRings): boolean {
	let inside = false

	for (const ring of rings) {
		if (pointInRing(lon, lat, ring)) {
			inside = !inside
		}
	}

	return inside
}

/**
 * Inside any polygon of a multi-polygon.
 */
export function pointInMultiPolygon(
	lon: number,
	lat: number,
	polygons: readonly (readonly ContainmentRing[])[]
): boolean {
	return polygons.some((rings) => pointInPolygon(lon, lat, rings))
}

/**
 * A collection of polygons, such as a country with islands or a lake with islands.
 */
export interface MultiPolygonLiteral<P extends PolygonPath = PolygonPath> extends GeoObjectLiteral {
	type: "MultiPolygon"

	coordinates: P[]
}


/**
 * A geometry as it arrives from `JSON.parse`, or a typed literal, with `type`
 * unchecked and no arity validation on `coordinates`.
 */
export type ParsedGeometry = GeometryLiteral | { type: string; coordinates?: unknown }

/**
 * A geometry's polygons in the `MultiPolygon` coordinate shape, with a bare `Polygon`
 * lifted to `[rings]` and `null` for any non-areal geometry.
 */
export function arealPolygons(geometry: ParsedGeometry | null | undefined): MultiPolygonRings | null {
	if (!geometry) return null

	if (geometry.type === "Polygon") return [geometry.coordinates as PolygonRings]

	if (geometry.type === "MultiPolygon") return geometry.coordinates as MultiPolygonRings

	return null
}

/**
 * The polygons of a geometry that must be areal, throwing when the geometry is not
 * a `Polygon` or `MultiPolygon`.
 */
export function requireArealPolygons(geometry: ParsedGeometry, subject: string, context: string): MultiPolygonRings {
	const polygons = arealPolygons(geometry)

	if (polygons) return polygons

	throw new Error(`${context}: ${subject} is a ${geometry.type}, expected Polygon or MultiPolygon`)
}

/**
 * Does an areal GeoJSON geometry contain the point, returning `null` for a non-areal
 * geometry rather than `false`.
 */
export function geometryContains(
	geometry: ParsedGeometry | null | undefined,
	lon: number,
	lat: number
): boolean | null {
	const polygons = arealPolygons(geometry)

	if (!polygons) return null

	return polygons.some((rings) => pointInPolygon(lon, lat, rings))
}

/**
 * An axis-aligned rectangle as a closed ring, in GeoJSON `[lon, lat]` order and
 * counter-clockwise.
 */
export function rectangleRing(minLon: number, minLat: number, maxLon: number, maxLat: number): number[][] {
	return [
		[minLon, minLat],
		[maxLon, minLat],
		[maxLon, maxLat],
		[minLon, maxLat],
		[minLon, minLat],
	]
}

/**
 * The same rectangle wound the other way — a hole, under the GeoJSON convention.
 */
export function reversedRing(minLon: number, minLat: number, maxLon: number, maxLat: number): number[][] {
	return [
		[minLon, minLat],
		[minLon, maxLat],
		[maxLon, maxLat],
		[maxLon, minLat],
		[minLon, minLat],
	]
}
