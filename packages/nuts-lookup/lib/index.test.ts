/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { rectangleRing, reversedRing } from "@mailwoman/spatial/geometries/polygon"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { expect, test } from "vitest"

import { makeNUTSAnnotator, nutsFromID, NUTSLookup } from "#index"
import type { NUTSDatabase } from "#schema"

test("nutsFromID: derives nested levels by prefix", () => {
	expect(nutsFromID("DE300")).toEqual({ level1: "DE3", level2: "DE30", level3: "DE300" })
	expect(nutsFromID("DE3")).toEqual({ level1: "DE3" })
	expect(nutsFromID("DE")).toEqual({})
})

test("NUTSLookup.explore: a point on an island inside a hole is inside the region", () => {
	using db = DatabaseClient.temp<NUTSDatabase>()

	db.exec(
		"CREATE TABLE nuts_regions (nutsID TEXT, level INTEGER, minLat REAL, maxLat REAL, minLon REAL, maxLon REAL, geom TEXT)"
	)

	const exteriorHoleIsland = stringifyJSON([
		[rectangleRing(0, 0, 10, 10), reversedRing(2, 2, 8, 8), rectangleRing(4, 4, 6, 6)],
	])

	db.prepare("INSERT INTO nuts_regions VALUES (?,?,?,?,?,?,?)").run("XX300", 3, 0, 10, 0, 10, exteriorHoleIsland)

	using lookup = new NUTSLookup({ database: db })

	expect(lookup.explore(1, 1)).toEqual({ level1: "XX3", level2: "XX30", level3: "XX300" })
	expect(lookup.explore(3, 3)).toBeNull()
	expect(lookup.explore(5, 5)).toEqual({ level1: "XX3", level2: "XX30", level3: "XX300" })
	expect(lookup.explore(20, 20)).toBeNull()
})

async function fixtureDB(): Promise<DatabaseClient<NUTSDatabase>> {
	const db = DatabaseClient.temp<NUTSDatabase>()

	db.exec(
		"CREATE TABLE nuts_regions (nutsID TEXT, level INTEGER, minLat REAL, maxLat REAL, minLon REAL, maxLon REAL, geom TEXT)"
	)

	const ins = db.prepare("INSERT INTO nuts_regions VALUES (?,?,?,?,?,?,?)")

	const square = stringifyJSON([
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

test("NUTSLookup.find: deepest containing region → nested codes", async () => {
	using db = await fixtureDB()
	using lookup = new NUTSLookup({ database: db })
	expect(lookup.explore(5, 5)).toEqual({ level1: "XX3", level2: "XX30", level3: "XX300" })
	expect(lookup.explore(50, 50)).toBeNull()
})

test("makeNUTSAnnotator: fills nuts inside, abstains outside", async () => {
	using db = await fixtureDB()
	using lookup = new NUTSLookup({ database: db })
	const annotate = makeNUTSAnnotator(lookup)
	expect(annotate({ lat: 5, lon: 5 })).toEqual({ nuts: { level1: "XX3", level2: "XX30", level3: "XX300" } })
	expect(annotate({ lat: 50, lon: 50 })).toEqual({})
})
