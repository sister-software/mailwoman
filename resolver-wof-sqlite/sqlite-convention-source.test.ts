/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `SqliteConventionSource` + the convention-asset auto-detect wiring (#290, Direction E). Proves
 *   the build-from-source asset path end-to-end: a `address_convention` table on an attached shard
 *   is auto-detected, queried on demand by WOF id, and the resolved convention reroutes `findPlace`
 *   dispatch — the same reroute the in-memory `opts.conventions` path gives, but through the
 *   asset.
 */
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WofSqlitePlaceLookup } from "./lookup.js"
import { SqliteConventionSource } from "./sqlite-convention-source.js"

/**
 * A minimal WOF fixture (DE country #90 + Plauen) WITH an attached `address_convention` table in the same schema, so
 * the lookup auto-detects it.
 */
function buildDb(conventions: Array<{ wof_id: number; convention: object }> = []): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, language TEXT, name TEXT NOT NULL);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER);
		CREATE TABLE postcode_locality (postcode TEXT, country TEXT, locality_id INTEGER, locality_name TEXT,
			aliases TEXT, distance_km REAL, is_containing INTEGER);
		CREATE TABLE address_convention (wof_id INTEGER PRIMARY KEY, convention TEXT NOT NULL, source TEXT NOT NULL);
	`)
	const spr = db.prepare(
		`INSERT INTO spr (id,parent_id,name,placetype,country,latitude,longitude,min_latitude,max_latitude,min_longitude,max_longitude,is_current,is_deprecated)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,-1,0)`
	)
	spr.run(90, 0, "Germany", "country", "DE", 51.0, 10.0, 47.0, 55.0, 6.0, 15.0)
	spr.run(3, 90, "Plauen", "locality", "DE", 50.49, 12.14, 50.4, 50.6, 12.0, 12.3)
	db.prepare(`INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)`).run("08523", "DE", 3, "Plauen", "", 0.0, 1)
	const ins = db.prepare(`INSERT INTO address_convention (wof_id, convention, source) VALUES (?, ?, ?)`)

	for (const c of conventions) ins.run(c.wof_id, JSON.stringify(c.convention), "test")

	return db
}

describe("SqliteConventionSource", () => {
	let db: DatabaseSync
	beforeEach(() => {
		db = buildDb([{ wof_id: 90, convention: { scoringWeights: { pc: 0.9 } } }])
	})
	afterEach(() => {
		db.close()
	})

	it("reads + parses a convention by WOF id, and returns undefined for a miss", () => {
		const src = new SqliteConventionSource(db, "main")
		expect(src.get(90)).toEqual({ scoringWeights: { pc: 0.9 } })
		expect(src.get(12345)).toBeUndefined()
	})

	it("memoizes (a second get for the same id does not re-query)", () => {
		const src = new SqliteConventionSource(db, "main")
		const spy = vi.spyOn(db, "prepare")
		src.get(90)
		src.get(90)
		expect(spy).toHaveBeenCalledTimes(1)
		spy.mockRestore()
	})
})

describe("convention-asset auto-detect → dispatch", () => {
	it("with no address_convention rows for the country, the coord-first path still recovers the town", async () => {
		const lookup = new WofSqlitePlaceLookup({ database: buildDb(), buildFts: true })
		const r = await lookup.findPlace({ text: "Plaun", placetype: "locality", postcode: "08523", country: "DE" })
		expect(r[0]?.name).toBe("Plauen")
		lookup.close()
	})

	it("an attached convention asset that drops postcode_area_resolution reroutes dispatch", async () => {
		// The convention asset lives in the same (main) schema; the lookup auto-detects address_convention
		// and queries it by the DE country WOF id (90). Dropping postcode_area_resolution means the typo
		// no longer recovers Plauen — proof the asset drives findPlace with no opts.conventions injection.
		const lookup = new WofSqlitePlaceLookup({
			database: buildDb([{ wof_id: 90, convention: { candidateStrategies: ["fallback_fuzzy_name_match"] } }]),
			buildFts: true,
		})
		const r = await lookup.findPlace({ text: "Plaun", placetype: "locality", postcode: "08523", country: "DE" })
		expect(r[0]?.name).not.toBe("Plauen")
		lookup.close()
	})

	it("warns loudly (once) on a convention that names an unknown strategy, then continues", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const lookup = new WofSqlitePlaceLookup({
			database: buildDb([
				{ wof_id: 90, convention: { candidateStrategies: ["does_not_exist", "fallback_fuzzy_name_match"] } },
			]),
			buildFts: true,
		})
		// First query warns about the unknown strategy and falls through to the known one.
		await lookup.findPlace({ text: "Plauen", placetype: "locality", country: "DE" })
		await lookup.findPlace({ text: "Plauen", placetype: "locality", country: "DE" })
		expect(warn).toHaveBeenCalledTimes(1) // once per name, not once per query
		expect(warn.mock.calls[0]![0]).toContain("does_not_exist")
		warn.mockRestore()
		lookup.close()
	})
})
