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
 *
 * @example
 * 	A polygon without holes:
 *
 * 	```json
 * 	{
 * 	"type": "Polygon",
 * 	"coordinates": [
 * 	[
 * 	[100, 0],
 * 	[101, 0],
 * 	[101, 1],
 * 	[100, 1],
 * 	[100, 0]
 * 	]
 * 	]
 * 	}
 * 	```
 */
export type SolidPolygonPath = [
	/**
	 * - A linear ring is a closed LineString with four or more positions.
	 * - The first and last positions are equivalent (they represent equivalent points).
	 */
	exteriorRing: LineStringPath,
]

/**
 * An array of positions forming a closed shape with holes, such as a country with islands or a lake with islands.
 *
 * @example
 * 	A polygon with holes:
 *
 * 	```json
 * 	{
 * 	"type": "Polygon",
 * 	"coordinates": [
 * 	[
 * 	[100.0, 0.0],
 * 	[101.0, 0.0],
 * 	[101.0, 1.0],
 * 	[100.0, 1.0],
 * 	[100.0, 0.0]
 * 	],
 * 	[
 * 	[100.8, 0.8],
 * 	[100.8, 0.2],
 * 	[100.2, 0.2],
 * 	[100.2, 0.8],
 * 	[100.8, 0.8]
 * 	]
 * 	]
 * 	}
 * 	```
 */
export type NestedPolygonPath = [
	/**
	 * - A linear ring is a closed LineString with four or more positions.
	 * - The first and last positions are equivalent (they represent equivalent points).
	 */
	exteriorRing: LineStringPath,
	/**
	 * - The interior rings are arrays of positions forming holes in the polygon.
	 */
	...interiorRings: LineStringPath[],
]

/**
 * A polygon geometry.
 *
 * @see {@linkcode PolygonLiteral} for applicable JSON schema.
 * @see {@linkcode SolidPolygonPath} for more information.
 * @see {@linkcode NestedPolygonPath} for more information.
 */
export type PolygonPath = SolidPolygonPath | NestedPolygonPath

/**
 * An array of positions forming a closed shape, such as a country or a lake.
 */
export interface PolygonLiteral<P extends PolygonPath = PolygonPath> extends GeoObjectLiteral {
	/**
	 * Declares the type of GeoJSON object as a `Polygon` geometry.
	 */
	type: "Polygon"
	/**
	 * An array of positions for each point in the geometry.
	 *
	 * @see {@link https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.6 | RFC 7946 Section 3.1.6}
	 * @see {@linkcode SolidPolygonPath}
	 * @see {@linkcode NestedPolygonPath}
	 */
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
// The parameter admits BOTH paths because distinguishing them is the function's job: defaulted to
// `SolidPolygonPath`, it cannot be asked about a polygon with holes without the caller asserting past the signature.
export function isSolidPolygonPath(input: PolygonLiteral<PolygonPath>): boolean {
	return input.coordinates.length === 1
}

/**
 * A linear ring as the containment predicates read it: positions of `[lon, lat, …]`.
 *
 * Deliberately looser than {@link LineStringPath} — the ray cast only ever indexes `[0]` and `[1]`, and the callers
 * arrive with different position types (`[number, number, ...number[]]` from the resolver's GeoJSON reader, plain
 * `number[][]` from a `JSON.parse` of a stored geometry column). A tight tuple type here would force a cast at every
 * call site and buy nothing the predicate uses.
 */
export type ContainmentRing = readonly (readonly number[])[]

/**
 * One polygon's rings: `[exterior, ...holes]` — a `Polygon`'s `coordinates`, read loosely (see
 * {@linkcode ContainmentRing}).
 */
export type PolygonRings = readonly ContainmentRing[]

/**
 * A feature's polygons — `MultiPolygon` coordinates, with a bare `Polygon` lifted into the same shape by
 * {@linkcode arealPolygons}.
 */
export type MultiPolygonRings = readonly PolygonRings[]

/**
 * Ray-cast a point against ONE linear ring — the even-odd crossing count. Shoot a ray along +lon and toggle on every
 * edge crossing.
 *
 * Points exactly on an edge are implementation-defined; either side is acceptable for geocoding, where admin boundaries
 * are Douglas-Peucker–simplified before they ever reach us.
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
 * Even-odd containment over a polygon's ring list (`[outer, hole₁, …]`).
 *
 * Being inside an odd number of rings means inside the polygon, which handles holes — and islands inside holes —
 * without depending on ring winding order. GeoJSON nominally specifies orientation, but the gazetteer sources do not
 * reliably honour it, so the orientation-free rule is the one that survives real data.
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
 * Inside ANY polygon of a multi-polygon.
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

	/**
	 * One ring array per polygon — `coordinates[polygon][ring][position]`, matching a `Polygon`'s `coordinates` lifted by
	 * exactly one level.
	 *
	 * @see {@link https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.7 | RFC 7946 Section 3.1.7}
	 */
	coordinates: P[]
}

//#region Ring-list geometry — the parsed-GeoJSON shape

/**
 * A geometry as it arrives from `JSON.parse`, or a typed literal. Nothing has checked the arity of a position and
 * `type` is whatever the source wrote, so a reader narrows on `type` and casts `coordinates` — {@linkcode arealPolygons}
 * is the one place that happens for the areal types.
 */
export type ParsedGeometry = GeometryLiteral | { type: string; coordinates?: unknown }

/**
 * A geometry's polygons in the `MultiPolygon` coordinate shape, whichever areal type it arrived as — `null` when the
 * geometry is not areal (a Point or a LineString bounds no area).
 *
 * The one place a `Polygon` is lifted to `[rings]`; a caller that must refuse a non-areal geometry does so on the
 * `null`, with its own message.
 */
export function arealPolygons(geometry: ParsedGeometry | null | undefined): MultiPolygonRings | null {
	if (!geometry) return null

	if (geometry.type === "Polygon") return [geometry.coordinates as PolygonRings]

	if (geometry.type === "MultiPolygon") return geometry.coordinates as MultiPolygonRings

	return null
}

/**
 * The polygons of a geometry that MUST be areal — {@linkcode arealPolygons} with the refusal every polygon ingest was
 * writing for itself.
 *
 * @param subject Names the feature in the refusal, e.g. `feature 41209`.
 * @param context Names the calling ingest, so a build log says which layer stopped.
 * @throws {Error} When the geometry is neither a `Polygon` nor a `MultiPolygon`.
 */
export function requireArealPolygons(geometry: ParsedGeometry, subject: string, context: string): MultiPolygonRings {
	const polygons = arealPolygons(geometry)

	if (polygons) return polygons

	throw new Error(`${context}: ${subject} is a ${geometry.type}, expected Polygon or MultiPolygon`)
}

/**
 * Does an areal GeoJSON geometry contain the point?
 *
 * The three-valued return is the point of the function. `null` means the geometry is NOT AREAL — a Point or a
 * LineString cannot contain anything — and a caller must read that as "no polygon on record", the same as a missing
 * geometry, never as a rejection. Collapsing it to `false` is how a place with a point-only record gets excluded from a
 * containment pass instead of falling through to the approximate path.
 *
 * `scripts/eval/pip-containment.py` grades the same containment truth against its own ray cast and has to be matched BY
 * HAND if this one changes — it is the one copy no import can reach.
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
 * An axis-aligned rectangle as a closed ring, in GeoJSON `[lon, lat]` order and counter-clockwise — the exterior
 * winding.
 *
 * SHARED BECAUSE THE WINDING IS A CONVENTION AND A SECOND COPY IS A SECOND PLACE FOR IT TO DRIFT. Three layer builders
 * hand-build rectangles for their fixture rungs, and each pairs this with {@link reversedRing} to make a hole. A copy
 * whose hole is wound the same way as its exterior produces a fixture that passes every structural check and tests
 * nothing about hole handling — which is the exact failure the area cross-check exists to catch in production data.
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

//#endregion
