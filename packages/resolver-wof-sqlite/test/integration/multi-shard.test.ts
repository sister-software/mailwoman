/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Multi-shard ATTACH tests for `WOFSQLitePlaceLookup`.
 *
 *   Uses on-disk fixture DBs because ATTACH requires file paths. Tests run unconditionally (the
 *   fixture DBs are built in-test via the same shape the real WOF distribution uses), so this
 *   doesn't gate on the real WOF being present.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { buildPlaceSearchFTS } from "@mailwoman/resolver-wof-sqlite/fts"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite/lookup"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

let scratch: TemporaryDirectory

function buildAdminShard(path: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

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
}

async function buildPostcodeShard(path: string): Promise<void> {
	using db = new DatabaseClient<WOFDatabase>(path)

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
}

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-multi-shard-")
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
})

describe("WOFSQLitePlaceLookup — multi-shard ATTACH", () => {
	test("opens a single shard via string path (backwards compatible)", async () => {
		const adminPath = scratch.resolve("whosonfirst-data-admin-us-latest.db")
		buildAdminShard(adminPath)
		using lookup = new WOFSQLitePlaceLookup({ databasePath: adminPath })

		const r = await lookup.findPlace({ text: "Springfield", placetype: "locality" })
		expect(r.length).toBeGreaterThan(0)
		expect(r[0]?.name).toBe("Springfield")
	})

	test("opens admin + postcode shards via array, auto-routes by placetype", async () => {
		const adminPath = scratch.resolve("whosonfirst-data-admin-us-latest.db")
		const pcPath = scratch.resolve("whosonfirst-data-postalcode-us-latest.db")
		buildAdminShard(adminPath)
		await buildPostcodeShard(pcPath)

		using lookup = new WOFSQLitePlaceLookup({ databasePath: [adminPath, pcPath] })

		const localities = await lookup.findPlace({ text: "Springfield", placetype: "locality" })
		expect(localities).toHaveLength(1)
		expect(localities[0]?.placetype).toBe("locality")
		expect(localities[0]?.id).toBe(101)

		// Postcode query → postalcode shard
		const postcodes = await lookup.findPlace({ text: "62701", placetype: "postalcode" })
		expect(postcodes).toHaveLength(1)
		expect(postcodes[0]?.placetype).toBe("postalcode")
		expect(postcodes[0]?.id).toBe(201)
	})

	test("ShardConfig.schemaName override + explicit placetypes hint", async () => {
		const adminPath = scratch.resolve("admin.db")
		const oddlyNamed = scratch.resolve("wherever-they-put-postcodes.db")
		buildAdminShard(adminPath)
		await buildPostcodeShard(oddlyNamed)

		using lookup = new WOFSQLitePlaceLookup({
			databasePath: [adminPath, { path: oddlyNamed, schemaName: "pc", placetypes: ["postalcode"] }],
		})

		const postcodes = await lookup.findPlace({ text: "90210", placetype: "postalcode" })
		expect(postcodes).toHaveLength(1)
		expect(postcodes[0]?.name).toBe("90210")
	})

	test("postcode bbox + proximity work via R*Tree on the attached shard", async () => {
		const adminPath = scratch.resolve("whosonfirst-data-admin-us-latest.db")
		const pcPath = scratch.resolve("whosonfirst-data-postalcode-us-latest.db")
		buildAdminShard(adminPath)
		await buildPostcodeShard(pcPath)

		using lookup = new WOFSQLitePlaceLookup({ databasePath: [adminPath, pcPath] })

		const r = await lookup.findPlace({
			text: "62701",
			placetype: "postalcode",
			near: { lat: 39.8, lon: -89.65, maxDistanceKm: 10 },
		})

		expect(r.length).toBeGreaterThan(0)
		expect(r[0]?.distanceKm).toBeDefined()
		expect(r[0]?.distanceKm).toBeLessThan(5)
	})

	test("query without placetype routes to main (admin) regardless of shards", async () => {
		const adminPath = scratch.resolve("whosonfirst-data-admin-us-latest.db")
		const pcPath = scratch.resolve("whosonfirst-data-postalcode-us-latest.db")
		buildAdminShard(adminPath)
		await buildPostcodeShard(pcPath)

		using lookup = new WOFSQLitePlaceLookup({ databasePath: [adminPath, pcPath] })

		const r = await lookup.findPlace({ text: "Springfield" })
		expect(r).toHaveLength(1)
		expect(r[0]?.placetype).toBe("locality")
	})

	test("placetype with no matching shard falls back to main", async () => {
		const adminPath = scratch.resolve("whosonfirst-data-admin-us-latest.db")
		buildAdminShard(adminPath)
		// Only admin shard — no postcode shard. A postalcode query falls back to main, returns
		// nothing because admin has no postalcodes.
		using lookup = new WOFSQLitePlaceLookup({ databasePath: [adminPath] })

		const r = await lookup.findPlace({ text: "62701", placetype: "postalcode" })
		expect(r).toEqual([])
	})
})
