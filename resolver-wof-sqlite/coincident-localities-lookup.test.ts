/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end test for WOFSqlitePlaceLookup.coincidentLocalitiesFor (#405): builds a fixture
 *   gazetteer, derives the coincident_roles relation (#403), then verifies the backend method joins
 *   the relation with `spr` and returns the dual-role completion candidates the resolver consumes.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildCoincidentRoles } from "./coincident-roles.ts"
import { WOFSqlitePlaceLookup } from "./lookup.ts"

let db: DatabaseSync
let lookup: WOFSqlitePlaceLookup

beforeEach(() => {
	db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL);
	`)
	const spr = db.prepare(
		`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude,
			min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated)
			VALUES (?, NULL, ?, ?, 'DE', ?, ?, ?, ?, ?, ?, 1, 0)`
	)
	// Germany 900 ⊃ Berlin region 910 ⊃ coincident locality 911 (city-state). Brandenburg: 920 + far town 921.
	spr.run(900, "Germany", "country", 51.1, 10.4, 47.3, 5.9, 55.1, 15.0)
	spr.run(910, "Berlin", "region", 52.52, 13.4, 52.22, 13.1, 52.82, 13.7)
	spr.run(911, "Berlin", "locality", 52.52, 13.4, 52.42, 13.3, 52.62, 13.5)
	spr.run(920, "Brandenburg", "region", 52.4, 13.0, 51.2, 11.8, 53.6, 14.2)
	spr.run(921, "Brandenburg", "locality", 52.41, 11.9, 52.36, 11.85, 52.46, 11.95)
	db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`).run(911, 3_600_000)
	const anc = db.prepare(`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)`)
	// Berlin locality 911's lineage: region 910 then country 900 (nearest-first expected).
	anc.run(911, 910, "region")
	anc.run(911, 900, "country")
	anc.run(910, 900, "country")
	anc.run(921, 920, "region")

	buildCoincidentRoles(db)
	lookup = new WOFSqlitePlaceLookup({ database: db, buildFTS: true })
})

afterEach(() => db.close())

describe("WOFSqlitePlaceLookup.coincidentLocalitiesFor", () => {
	test("returns the dual-role locality joined with spr", () => {
		const berlin = lookup.coincidentLocalitiesFor(910)
		expect(berlin).toHaveLength(1)
		expect(berlin[0]).toMatchObject({
			id: 911,
			name: "Berlin",
			placetype: "locality",
			country: "DE",
			lat: 52.52,
			lon: 13.4,
			relationshipType: "city-state",
			population: 3_600_000,
		})
	})

	test("returns [] for a region not in the relation (Brandenburg's town is too far)", () => {
		expect(lookup.coincidentLocalitiesFor(920)).toHaveLength(0)
	})

	test("returns [] for an unknown admin id", () => {
		expect(lookup.coincidentLocalitiesFor(99999)).toHaveLength(0)
	})

	test("ancestors() returns the lineage nearest-first, joined with spr (#404)", () => {
		expect(lookup.ancestors(911)).toEqual([
			{ id: 910, placetype: "region", name: "Berlin" },
			{ id: 900, placetype: "country", name: "Germany" },
		])
		expect(lookup.ancestors(99999)).toHaveLength(0)
	})

	test("returns [] gracefully when the relation table is absent", () => {
		const bare = new DatabaseSync(":memory:")
		bare.exec(`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL,
			max_longitude REAL, is_current INTEGER, is_deprecated INTEGER, parent_id INTEGER);
			CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);`)
		const bareLookup = new WOFSqlitePlaceLookup({ database: bare, buildFTS: true })
		expect(bareLookup.coincidentLocalitiesFor(910)).toHaveLength(0)
		bare.close()
	})
})
