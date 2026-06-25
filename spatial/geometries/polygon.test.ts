/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import {
	isPolygonLiteral,
	isResidentialElement,
	isSolidPolygonPath,
	polygonToOSMFilter,
	type OSMOverpassElement,
	type PolygonLiteral,
} from "./polygon.js"

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
	const withHole = {
		type: "Polygon",
		coordinates: [SOLID.coordinates[0], SOLID.coordinates[0]],
	} as unknown as PolygonLiteral
	expect(isSolidPolygonPath(withHole)).toBe(false)
})

test("polygonToOSMFilter: emits the exterior ring as Overpass 'lat lon' pairs (NOT GeoJSON lon,lat)", () => {
	// GeoJSON positions are [lon, lat]; Overpass wants "lat lon" — this swap is the foot-gun.
	expect(polygonToOSMFilter(SOLID)).toBe("poly:'0 100 0 101 1 101 1 100 0 100'")
	expect(polygonToOSMFilter({ type: "Point" } as unknown as PolygonLiteral)).toBe("") // non-polygon → empty
})

test("isResidentialElement: rejects commercial tags + restaurants, accepts a plain address node", () => {
	const el = (tags: Record<string, string>): OSMOverpassElement =>
		({ type: "node", id: 1, lat: 0, lon: 0, tags }) as unknown as OSMOverpassElement

	expect(isResidentialElement(el({ "addr:housenumber": "5", "addr:street": "Main" }))).toBe(true)
	expect(isResidentialElement(el({ shop: "bakery" }))).toBe(false) // forbidden commercial tag
	expect(isResidentialElement(el({ office: "company" }))).toBe(false)
	expect(isResidentialElement(el({ amenity: "restaurant" }))).toBe(false) // restaurant special-case
	expect(isResidentialElement(el({ amenity: "bench" }))).toBe(true) // a non-forbidden amenity is fine
})
