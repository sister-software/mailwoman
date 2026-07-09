/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { GeometryLiteral } from "@mailwoman/spatial"
import { expect, test } from "vitest"
import wkx from "wkx"

import {
	geometryToEWKB,
	geometryToEWKH,
	geometryToSQL,
	geometryToWKB,
	geometryToWKT,
	wellKnownGeometryToGeoJSON,
} from "./well-known-text.ts"

const POINT: GeometryLiteral = { type: "Point", coordinates: [30, 10] }

// A closed exterior ring (last vertex repeats the first), as GeoJSON requires.
const POLYGON: GeometryLiteral = {
	type: "Polygon",
	coordinates: [
		[
			[30, 10],
			[40, 40],
			[20, 40],
			[10, 20],
			[30, 10],
		],
	],
}

// The 4-level MultiPolygon literal doesn't narrow against the GeometryLiteral union; cast it.
const MULTIPOLYGON = {
	type: "MultiPolygon",
	coordinates: [
		[
			[
				[30, 20],
				[45, 40],
				[10, 40],
				[30, 20],
			],
		],
		[
			[
				[15, 5],
				[40, 10],
				[10, 20],
				[5, 10],
				[15, 5],
			],
		],
	],
} as unknown as GeometryLiteral

test("wellKnownGeometryToGeoJSON: parses a WKT POINT into exact GeoJSON coordinates", () => {
	const geo = wellKnownGeometryToGeoJSON<GeometryLiteral>("POINT(30 10)")
	expect(geo).toEqual(POINT)
})

test("wellKnownGeometryToGeoJSON: parses a WKT POLYGON, preserving ring order and closure", () => {
	const geo = wellKnownGeometryToGeoJSON<GeometryLiteral>("POLYGON((30 10,40 40,20 40,10 20,30 10))")
	expect(geo).toEqual(POLYGON)
})

test("wellKnownGeometryToGeoJSON: parses a WKT MULTIPOLYGON into two distinct polygons", () => {
	const geo = wellKnownGeometryToGeoJSON<GeometryLiteral>(
		"MULTIPOLYGON(((30 20,45 40,10 40,30 20)),((15 5,40 10,10 20,5 10,15 5)))"
	)
	expect(geo).toEqual(MULTIPOLYGON)
})

test("wellKnownGeometryToGeoJSON: parses an EWKB buffer back into the source geometry", () => {
	// Produce a known EWKB buffer, then round-trip it through the parser.
	const ewkb = wkx.Geometry.parseGeoJSON(POINT).toEwkb()
	const geo = wellKnownGeometryToGeoJSON<GeometryLiteral>(ewkb)
	expect(geo).toEqual(POINT)
})

test("wellKnownGeometryToGeoJSON: throws on malformed WKT", () => {
	expect(() => wellKnownGeometryToGeoJSON("NOT A GEOMETRY")).toThrow()
})

test("geometryToWKT: serializes GeoJSON back to its canonical WKT string", () => {
	expect(geometryToWKT(POINT)).toBe("POINT(30 10)")
	expect(geometryToWKT(POLYGON)).toBe("POLYGON((30 10,40 40,20 40,10 20,30 10))")
	expect(geometryToWKT(MULTIPOLYGON)).toBe("MULTIPOLYGON(((30 20,45 40,10 40,30 20)),((15 5,40 10,10 20,5 10,15 5)))")
})

test("geometryToWKT ↔ wellKnownGeometryToGeoJSON: lossless round-trip for a polygon", () => {
	const wkt = geometryToWKT(POLYGON)
	const back = wellKnownGeometryToGeoJSON<GeometryLiteral>(wkt)
	expect(back).toEqual(POLYGON)
})

test("geometryToWKB: produces the exact little-endian WKB byte string for a POINT", () => {
	// 01 (LE) | 01000000 (type=Point) | 30 as float64 LE | 10 as float64 LE
	const wkb = geometryToWKB(POINT)
	expect(wkb.toString("hex")).toBe("01010000000000000000003e400000000000002440")
})

test("geometryToWKB: round-trips through the parser back to source GeoJSON", () => {
	const wkb = geometryToWKB(MULTIPOLYGON)
	const back = wkx.Geometry.parse(wkb).toGeoJSON()
	expect(back).toEqual(MULTIPOLYGON)
})

test("geometryToEWKB: tags the geometry with the SRID-flag the plain WKB lacks", () => {
	// EWKB sets the 0x20000000 SRID flag on the type word, so the hex differs from plain WKB.
	const ewkb = geometryToEWKB(POINT)
	expect(ewkb.toString("hex")).toBe("0101000020e61000000000000000003e400000000000002440")
	// Distinct from plain WKB.
	expect(ewkb.toString("hex")).not.toBe(geometryToWKB(POINT).toString("hex"))
})

test("geometryToEWKH: is the hex-encoded form of the EWKB buffer", () => {
	expect(geometryToEWKH(POINT)).toBe(geometryToEWKB(POINT).toString("hex"))
	expect(geometryToEWKH(POINT)).toBe("0101000020e61000000000000000003e400000000000002440")
})

test("geometryToSQL: returns a thunk emitting a GeomFromEWKB literal for a real geometry", () => {
	const thunk = geometryToSQL(POINT)
	expect(typeof thunk).toBe("function")
	expect(thunk()).toBe(`GeomFromEWKB('${geometryToEWKH(POINT)}')`)
})

test("geometryToSQL: null/undefined geometry yields a thunk that emits the SQL literal NULL", () => {
	expect(geometryToSQL(null)()).toBe("NULL")
	expect(geometryToSQL(undefined)()).toBe("NULL")
})
