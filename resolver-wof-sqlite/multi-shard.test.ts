/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Multi-shard ATTACH tests for `WOFSqlitePlaceLookup`.
 *
 *   Uses on-disk fixture DBs because ATTACH requires file paths. Tests run unconditionally (the
 *   fixture DBs are built in-test via the same shape the real WOF distribution uses), so this
 *   doesn't gate on the real WOF being present.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildPlaceSearchFTS } from "./fts.ts"
import { WOFSqlitePlaceLookup } from "./lookup.ts"

let scratch: string

function buildAdminShard(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		INSERT INTO spr VALUES (101, NULL, 'Springfield', 'locality', 'US', 39.80, -89.65, 39.75, 39.85, -89.70, -89.60, -1, 0);
		INSERT INTO spr VALUES (102, NULL, 'Beverly Hills', 'locality', 'US', 34.07, -118.40, 34.05, 34.09, -118.42, -118.38, 1, 0);
		INSERT INTO spr VALUES (103, NULL, 'Paris', 'locality', 'FR', 48.85, 2.34, 48.81, 48.90, 2.22, 2.46, -1, 0);
	`)
	buildPlaceSearchFTS(db)
	db.close()
}

function buildPostcodeShard(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		INSERT INTO spr VALUES (201, 101, '62701', 'postalcode', 'US', 39.80, -89.65, 39.78, 39.82, -89.67, -89.63, 1, 0);
		INSERT INTO spr VALUES (202, 102, '90210', 'postalcode', 'US', 34.10, -118.41, 34.08, 34.12, -118.43, -118.39, -1, 0);
		INSERT INTO spr VALUES (203, 101, '62702', 'postalcode', 'US', 39.82, -89.63, 39.80, 39.84, -89.65, -89.61, 1, 0);
	`)
	buildPlaceSearchFTS(db)
	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-multi-shard-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("WOFSqlitePlaceLookup — multi-shard ATTACH", () => {
	test("opens a single shard via string path (backwards compatible)", async () => {
		const adminPath = join(scratch, "whosonfirst-data-admin-us-latest.db")
		buildAdminShard(adminPath)
		const lookup = new WOFSqlitePlaceLookup({ databasePath: adminPath })

		try {
			const r = await lookup.findPlace({ text: "Springfield", placetype: "locality" })
			expect(r.length).toBeGreaterThan(0)
			expect(r[0]?.name).toBe("Springfield")
		} finally {
			lookup.close()
		}
	})

	test("opens admin + postcode shards via array, auto-routes by placetype", async () => {
		const adminPath = join(scratch, "whosonfirst-data-admin-us-latest.db")
		const pcPath = join(scratch, "whosonfirst-data-postalcode-us-latest.db")
		buildAdminShard(adminPath)
		buildPostcodeShard(pcPath)

		const lookup = new WOFSqlitePlaceLookup({ databasePath: [adminPath, pcPath] })

		try {
			// Locality query → admin shard
			const localities = await lookup.findPlace({ text: "Springfield", placetype: "locality" })
			expect(localities.length).toBe(1)
			expect(localities[0]?.placetype).toBe("locality")
			expect(localities[0]?.id).toBe(101)

			// Postcode query → postalcode shard
			const postcodes = await lookup.findPlace({ text: "62701", placetype: "postalcode" })
			expect(postcodes.length).toBe(1)
			expect(postcodes[0]?.placetype).toBe("postalcode")
			expect(postcodes[0]?.id).toBe(201)
		} finally {
			lookup.close()
		}
	})

	test("ShardConfig.schemaName override + explicit placetypes hint", async () => {
		const adminPath = join(scratch, "admin.db")
		const oddlyNamed = join(scratch, "wherever-they-put-postcodes.db")
		buildAdminShard(adminPath)
		buildPostcodeShard(oddlyNamed)

		const lookup = new WOFSqlitePlaceLookup({
			databasePath: [adminPath, { path: oddlyNamed, schemaName: "pc", placetypes: ["postalcode"] }],
		})

		try {
			// Even though the filename derives `wherever_they_put_postcodes`, the override gave it
			// a `pc` schema name with explicit `postalcode` routing.
			const postcodes = await lookup.findPlace({ text: "90210", placetype: "postalcode" })
			expect(postcodes.length).toBe(1)
			expect(postcodes[0]?.name).toBe("90210")
		} finally {
			lookup.close()
		}
	})

	test("postcode bbox + proximity work via R*Tree on the attached shard", async () => {
		const adminPath = join(scratch, "whosonfirst-data-admin-us-latest.db")
		const pcPath = join(scratch, "whosonfirst-data-postalcode-us-latest.db")
		buildAdminShard(adminPath)
		buildPostcodeShard(pcPath)

		const lookup = new WOFSqlitePlaceLookup({ databasePath: [adminPath, pcPath] })

		try {
			// "62701" near Illinois coords with a 10km hard filter — only 62701 and 62702 in fixture
			// are near these coords, but the FTS phrase exact-match on "62701" picks just one.
			const r = await lookup.findPlace({
				text: "62701",
				placetype: "postalcode",
				near: { lat: 39.8, lon: -89.65, maxDistanceKm: 10 },
			})
			expect(r.length).toBeGreaterThan(0)
			expect(r[0]?.distanceKm).toBeDefined()
			expect(r[0]?.distanceKm).toBeLessThan(5)
		} finally {
			lookup.close()
		}
	})

	test("query without placetype routes to main (admin) regardless of shards", async () => {
		const adminPath = join(scratch, "whosonfirst-data-admin-us-latest.db")
		const pcPath = join(scratch, "whosonfirst-data-postalcode-us-latest.db")
		buildAdminShard(adminPath)
		buildPostcodeShard(pcPath)

		const lookup = new WOFSqlitePlaceLookup({ databasePath: [adminPath, pcPath] })

		try {
			// No placetype → main only. "62701" won't match (it's in postcode shard); Springfield will.
			const r = await lookup.findPlace({ text: "Springfield" })
			expect(r.length).toBe(1)
			expect(r[0]?.placetype).toBe("locality")
		} finally {
			lookup.close()
		}
	})

	test("placetype with no matching shard falls back to main", async () => {
		const adminPath = join(scratch, "whosonfirst-data-admin-us-latest.db")
		buildAdminShard(adminPath)
		// Only admin shard — no postcode shard. A postalcode query falls back to main, returns
		// nothing because admin has no postalcodes.
		const lookup = new WOFSqlitePlaceLookup({ databasePath: [adminPath] })

		try {
			const r = await lookup.findPlace({ text: "62701", placetype: "postalcode" })
			expect(r).toEqual([])
		} finally {
			lookup.close()
		}
	})
})
