/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import { makeTimezoneAnnotator, offsetSecForTimezone, pointInMultiPolygon, TimezoneLookup } from "./index.js"

const SQUARE: number[][][][] = [
	[
		[
			[0, 0],
			[0, 10],
			[10, 10],
			[10, 0],
			[0, 0],
		],
	],
]

test("pointInMultiPolygon: inside vs outside a unit square", () => {
	expect(pointInMultiPolygon(5, 5, SQUARE)).toBe(true)
	expect(pointInMultiPolygon(15, 15, SQUARE)).toBe(false)
	expect(pointInMultiPolygon(-1, 5, SQUARE)).toBe(false)
})

test("offsetSecForTimezone: Intl-derived, DST-aware", () => {
	// Tokyo has no DST: always +9h.
	expect(offsetSecForTimezone("Asia/Tokyo", new Date("2026-06-15T00:00:00Z"))).toBe(32400)
	// New York: EST (-5h) in January, EDT (-4h) in July.
	expect(offsetSecForTimezone("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe(-18000)
	expect(offsetSecForTimezone("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe(-14400)
	expect(offsetSecForTimezone("Not/AZone")).toBeUndefined()
})

function fixtureDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec("CREATE TABLE timezone_polygons (tzid TEXT, minLat REAL, maxLat REAL, minLon REAL, maxLon REAL, geom TEXT)")
	db.prepare("INSERT INTO timezone_polygons VALUES (?,?,?,?,?,?)").run(
		"Test/Zone",
		0,
		10,
		0,
		10,
		JSON.stringify(SQUARE)
	)
	return db
}

test("TimezoneLookup.find: bbox-prefilter + PIP returns the containing zone", () => {
	const lookup = new TimezoneLookup({ database: fixtureDb() })
	expect(lookup.find(5, 5)).toBe("Test/Zone")
	expect(lookup.find(50, 50)).toBeNull()
})

test("makeTimezoneAnnotator: fills AnnotationSet.timezone", () => {
	const annotate = makeTimezoneAnnotator(new TimezoneLookup({ database: fixtureDb() }))
	expect(annotate({ lat: 5, lon: 5 })).toEqual({ timezone: { name: "Test/Zone" } })
	expect(annotate({ lat: 50, lon: 50 })).toEqual({})
})
