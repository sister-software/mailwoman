/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isResidentialElement, polygonToOSMFilter, type OSMOverpassElement } from "@mailwoman/osm/overpass/nodes"
import type { PolygonLiteral } from "@mailwoman/spatial/geometries/polygon"
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
