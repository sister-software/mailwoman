/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { expect, test } from "vitest"

import { makeNutsAnnotator, nutsFromId, NutsLookup, pointInMultiPolygon } from "./index.js"

test("nutsFromId: derives nested levels by prefix", () => {
	expect(nutsFromId("DE300")).toEqual({ level1: "DE3", level2: "DE30", level3: "DE300" })
	expect(nutsFromId("DE3")).toEqual({ level1: "DE3" })
	expect(nutsFromId("DE")).toEqual({})
})

test("pointInMultiPolygon: inside vs outside", () => {
	const square: number[][][][] = [
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
	expect(pointInMultiPolygon(5, 5, square)).toBe(true)
	expect(pointInMultiPolygon(20, 20, square)).toBe(false)
})

function fixtureDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(
		"CREATE TABLE nuts_regions (nutsId TEXT, level INTEGER, minLat REAL, maxLat REAL, minLon REAL, maxLon REAL, geom TEXT)"
	)
	const ins = db.prepare("INSERT INTO nuts_regions VALUES (?,?,?,?,?,?,?)")
	const square = JSON.stringify([
		[
			[
				[0, 0],
				[0, 10],
				[10, 10],
				[10, 0],
				[0, 0],
			],
		],
	])
	ins.run("XX300", 3, 0, 10, 0, 10, square)

	return db
}

test("NutsLookup.find: deepest containing region → nested codes", () => {
	const lookup = new NutsLookup({ database: fixtureDb() })
	expect(lookup.find(5, 5)).toEqual({ level1: "XX3", level2: "XX30", level3: "XX300" })
	expect(lookup.find(50, 50)).toBeNull()
})

test("makeNutsAnnotator: fills nuts inside, abstains outside", () => {
	const annotate = makeNutsAnnotator(new NutsLookup({ database: fixtureDb() }))
	expect(annotate({ lat: 5, lon: 5 })).toEqual({ nuts: { level1: "XX3", level2: "XX30", level3: "XX300" } })
	expect(annotate({ lat: 50, lon: 50 })).toEqual({})
})
