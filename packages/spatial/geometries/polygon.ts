/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { ResourceError } from "@mailwoman/core/errors"

import type { GeoObjectLiteral } from "../objects.ts"
import type { LineStringPath } from "./line-string.ts"

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
export interface PolygonLiteral<P extends PolygonPath = SolidPolygonPath> extends GeoObjectLiteral {
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
export function pointInPolygon(lon: number, lat: number, rings: readonly ContainmentRing[]): boolean {
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
export interface MultiPolygonLiteral<P extends PolygonPath = SolidPolygonPath> extends GeoObjectLiteral {
	type: "MultiPolygon"

	/**
	 * One ring array per polygon — `coordinates[polygon][ring][position]`, matching a `Polygon`'s `coordinates` lifted by
	 * exactly one level.
	 *
	 * @see {@link https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.7 | RFC 7946 Section 3.1.7}
	 */
	coordinates: P[]
}

/**
 * Predicate for checking if a GeoJSON object is a `MultiPolygon` geometry.
 */

/**
 * Given a polygon geometry, return an OSM filter string.
 *
 * This is useful when working with the Overpass API.
 */
// `unknown`, matched by the guard on the next line: this reads geometry off an API response, and a parameter that
// promises a polygon makes the guard look redundant while forcing every test of it to assert past the signature.
export function polygonToOSMFilter(input: unknown): string {
	if (!isPolygonLiteral(input)) return ""

	const [exteriorRing] = input.coordinates

	const filter = exteriorRing.map(([lon, lat]) => `${lat} ${lon}`).join(" ")

	return `poly:'${filter}'`
}

/**
 * Tags returned by the Overpass API for a node.
 *
 * @category OSM
 */
export const OSMNodeTag = {
	HouseNumber: "addr:housenumber",
	PostCode: "addr:postcode",
	Street: "addr:street",
	State: "addr:state",
	City: "addr:city",
	Website: "website",
	Email: "email",
	Phone: "phone",
	Shop: "shop",
	Brand: "brand",
	Cuisine: "cuisine",
	Name: "name",
	Healthcare: "healthcare",
	Office: "office",
	Amenity: "amenity",
} as const

export type OSMNodeTag = (typeof OSMNodeTag)[keyof typeof OSMNodeTag]

/**
 * OSM node tags that disqualify a node from being treated as residential — a node carrying one of these is
 * infrastructure or commercial, whatever else it claims.
 */
export const ForbiddenResidentialOSMNodeTags: ReadonlySet<OSMNodeTag> = new Set<OSMNodeTag>([
	OSMNodeTag.Shop,
	OSMNodeTag.Brand,
	OSMNodeTag.Cuisine,
	OSMNodeTag.Office,
	OSMNodeTag.Healthcare,
])

export type OSMNodeTagRecord = Record<OSMNodeTag, string | undefined>

export interface OSMOverpassElement {
	type: "node"
	id: number
	lat: number
	lon: number
	tags: OSMNodeTagRecord
}

export interface OSMOverpassResponseBody {
	version: string
	generator: string
	osm3s: {
		timestamp_osm_base: string
		copyright: string
	}
	elements: OSMOverpassElement[]
}

/**
 * Given an OSM element, attempts to infer if the result is a residential address.
 */
export function isResidentialElement(element: OSMOverpassElement): boolean {
	for (const key in element.tags) {
		if (ForbiddenResidentialOSMNodeTags.has(key as OSMNodeTag)) return false
	}

	if (element.tags[OSMNodeTag.Amenity] === "restaurant") return false

	return true
}

const overpassClient = new APIClient({ displayName: "overpass", retry: true })

export function fetchOSMElementViaOverpassAPI(input: PolygonLiteral): Promise<OSMOverpassElement[]> {
	const filter = polygonToOSMFilter(input)

	const url = new URL("http://overpass-api.de/api/interpreter")
	url.searchParams.set("data", `[out:json];(node['addr:housenumber'](${filter}););out body;>;out skel qt;`)

	// Overpass is a free shared endpoint that answers a throttle with 429 + `Retry-After`. `retry: true` is what
	// reads that header, which is the server stating its own limit rather than this file guessing one. `ResourceError`
	// now arrives from the client instead of being assembled here.
	return overpassClient
		.fetch<OSMOverpassResponseBody>({ url: url.toString() })
		.then(pluckResponseData)
		.then((body) => body.elements)
		.catch((error) => {
			throw ResourceError.wrap(error, "osm", "overpass-api", "fetch")
		})
}

//#region Ring-list geometry — the parsed-GeoJSON shape

/**
 * A GeoJSON position — `[lon, lat]`, possibly carrying extra dimensions this module ignores.
 *
 * Deliberately looser than {@linkcode Coordinates2D}: a gazetteer geometry arrives from `JSON.parse`, where nothing has
 * checked the arity, and a tuple type there would be a claim about data rather than a description of it.
 */
export type GeojsonPosition = [number, number, ...number[]]

/**
 * A GeoJSON `Polygon` as a RING LIST — `[outerRing, hole1, hole2, …]`.
 *
 * This coexists with {@linkcode PolygonLiteral} on purpose, and the difference is required. `PolygonLiteral` defaults to
 * {@linkcode SolidPolygonPath}, a one-element tuple that cannot express a hole; a real administrative boundary routinely
 * has them (a country with a lake, a locality with an enclave). Use this type for geometry read off a gazetteer, and
 * `PolygonLiteral` where the solid/nested distinction is one you are asserting rather than discovering.
 */
export interface GeojsonPolygon {
	type: "Polygon"
	coordinates: GeojsonPosition[][]
}

/**
 * A GeoJSON `MultiPolygon` — one ring list per polygon.
 */
export interface GeojsonMultiPolygon {
	type: "MultiPolygon"
	coordinates: GeojsonPosition[][][]
}

/**
 * Either areal geometry, or an open fallback for the types containment cannot answer (Point, LineString, …).
 */
export type GeojsonGeometry = GeojsonPolygon | GeojsonMultiPolygon | { type: string; coordinates?: unknown }

/**
 * Even-odd containment over a polygon's ring list (`[outer, hole1, …]`).
 *
 * A named alias for {@linkcode pointInPolygon}: the "rings" spelling is what makes the ring-list argument obvious at a
 * call site that has just pulled `coordinates` off a parsed geometry.
 *
 * `scripts/eval/pip-containment.py` grades the same containment truth against its own ray cast and has to be matched BY
 * HAND if this one changes — it is the one copy no import can reach.
 */
export function pointInPolygonRings(lon: number, lat: number, rings: readonly GeojsonPosition[][]): boolean {
	return pointInPolygon(lon, lat, rings)
}

/**
 * Does an areal GeoJSON geometry contain the point?
 *
 * The three-valued return is the point of the function. `null` means the geometry is NOT AREAL — a Point or a
 * LineString cannot contain anything — and a caller must read that as "no polygon on record", the same as a missing
 * geometry, never as a rejection. Collapsing it to `false` is how a place with a point-only record gets excluded from a
 * containment pass instead of falling through to the approximate path.
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
