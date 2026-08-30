/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { geometryContains, isPolygonLiteral, isResidentialElement, isSolidPolygonPath, pointInPolygonRings, pointInRing, polygonToOSMFilter, type GeojsonPosition, type PolygonPath, type OSMOverpassElement, type PolygonLiteral } from "@mailwoman/spatial/geometries/polygon"
import { expect, test } from "vitest"

const SOLID: PolygonLiteral = {
	type: "Polygon",
	coordinates: [
		[
			[100, 0],
			[101, 0],
			[101, 1],
			[100, 1],
			[100, 0],
		],
	],
}

test("isPolygonLiteral: only a {type:'Polygon', coordinates: []} object qualifies", () => {
	expect(isPolygonLiteral(SOLID)).toBe(true)
	expect(isPolygonLiteral({ type: "Point", coordinates: [0, 0] })).toBe(false)
	expect(isPolygonLiteral({ type: "Polygon" })).toBe(false) // no coordinates
	expect(isPolygonLiteral(null)).toBe(false)
	expect(isPolygonLiteral("Polygon")).toBe(false)
})

test("isSolidPolygonPath: one ring = solid, more rings = has holes", () => {
	expect(isSolidPolygonPath(SOLID)).toBe(true)

	const withHole: PolygonLiteral<PolygonPath> = {
		type: "Polygon",
		coordinates: [SOLID.coordinates[0]!, SOLID.coordinates[0]!],
	}

	expect(isSolidPolygonPath(withHole)).toBe(false)
})

test("polygonToOSMFilter: emits the exterior ring as Overpass 'lat lon' pairs (NOT GeoJSON lon,lat)", () => {
	// GeoJSON positions are [lon, lat]; Overpass wants "lat lon" — this swap is the foot-gun.
	expect(polygonToOSMFilter(SOLID)).toBe("poly:'0 100 0 101 1 101 1 100 0 100'")
	expect(polygonToOSMFilter({ type: "Point" })).toBe("") // non-polygon → empty
})

test("isResidentialElement: rejects commercial tags + restaurants, accepts a plain address node", () => {
	const el = (tags: Record<string, string>): OSMOverpassElement =>
		({ type: "node", id: 1, lat: 0, lon: 0, tags }) as OSMOverpassElement

	expect(isResidentialElement(el({ "addr:housenumber": "5", "addr:street": "Main" }))).toBe(true)
	expect(isResidentialElement(el({ shop: "bakery" }))).toBe(false) // forbidden commercial tag
	expect(isResidentialElement(el({ office: "company" }))).toBe(false)
	expect(isResidentialElement(el({ amenity: "restaurant" }))).toBe(false) // restaurant special-case
	expect(isResidentialElement(el({ amenity: "bench" }))).toBe(true) // a non-forbidden amenity is fine
})

// A unit square ring in [lon, lat], closed.
const SQUARE: GeojsonPosition[] = [
	[0, 0],
	[0, 1],
	[1, 1],
	[1, 0],
	[0, 0],
]

test("pointInRing: inside vs outside a simple ring (ray-cast even-odd)", () => {
	expect(pointInRing(0.5, 0.5, SQUARE)).toBe(true)
	expect(pointInRing(2, 0.5, SQUARE)).toBe(false) // east of the ring
	expect(pointInRing(-1, 0.5, SQUARE)).toBe(false) // west of the ring
	expect(pointInRing(0.5, 2, SQUARE)).toBe(false) // north of the ring
})

test("pointInPolygonRings: a hole punches a void (even-odd handles holes, no orientation rules)", () => {
	const outer: GeojsonPosition[] = [
		[0, 0],
		[0, 10],
		[10, 10],
		[10, 0],
		[0, 0],
	]

	const hole: GeojsonPosition[] = [
		[4, 4],
		[4, 6],
		[6, 6],
		[6, 4],
		[4, 4],
	]

	// inside outer, NOT in the hole → contained
	expect(pointInPolygonRings(1, 1, [outer, hole])).toBe(true)
	// inside the hole → an odd-count void → NOT contained
	expect(pointInPolygonRings(5, 5, [outer, hole])).toBe(false)
	// outside everything
	expect(pointInPolygonRings(20, 20, [outer, hole])).toBe(false)
})

test("geometryContains: Polygon / MultiPolygon test; non-areal and null geometry → null", () => {
	const polygon = { type: "Polygon" as const, coordinates: [SQUARE] }

	expect(geometryContains(polygon, 0.5, 0.5)).toBe(true)
	expect(geometryContains(polygon, 5, 5)).toBe(false)

	const multi = {
		type: "MultiPolygon" as const,
		coordinates: [
			[SQUARE],
			[
				[
					[10, 10],
					[10, 11],
					[11, 11],
					[11, 10],
					[10, 10],
				] as GeojsonPosition[],
			],
		],
	}

	expect(geometryContains(multi, 0.5, 0.5)).toBe(true) // in the first polygon
	expect(geometryContains(multi, 10.5, 10.5)).toBe(true) // in the second polygon
	expect(geometryContains(multi, 5, 5)).toBe(false) // in neither

	// non-areal / missing → null (the "no polygon on record" fallback, never a rejection)
	expect(geometryContains({ type: "Point", coordinates: [0.5, 0.5] }, 0.5, 0.5)).toBeNull()
	expect(geometryContains(null, 0.5, 0.5)).toBeNull()
	expect(geometryContains(undefined, 0.5, 0.5)).toBeNull()
})
