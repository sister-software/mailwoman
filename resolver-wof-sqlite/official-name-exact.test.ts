/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #936 option 3 — `officialNameExact`: an OFFICIAL name (preferred form in an official language
 *   of the place's country, `names.official = 1` from the #940 ingest bit) joins the NAME-exact
 *   sub-tier instead of the alias-exact one, floor-gated on the holder's population. The Åbo
 *   fixture mirrors the motivating row: unscoped "Åbo" must reach Turku (its official Swedish
 *   name, pop 207k) rather than a hamlet literally named Åbo — while Paris Township's plain alias
 *   still loses to Paris' own name, and pre-#940 gazetteers (no `official` column) fail soft.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, test } from "vitest"

import type { RankingWeights } from "./lookup.js"
import { WOFSqlitePlaceLookup } from "./lookup.js"

interface SeedPlace {
	id: number
	name: string
	country: string
	population?: number
	/** Plain aliases (official = 0). */
	aliases?: string[]
	/** Official-language aliases (official = 1) — the #940 ingest bit. */
	officialAliases?: string[]
}

/** Same production shape as the exact-match-tiering fixture, plus the #940 `official` column. */
function buildDB(places: SeedPlace[], opts?: { omitOfficialColumn?: boolean }): DatabaseSync {
	const db = new DatabaseSync(":memory:")

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT${
			opts?.omitOfficialColumn ? "" : ", official INTEGER NOT NULL DEFAULT 0"
		});
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
	`)
	const insertSpr = db.prepare(`
		INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude,
			min_latitude, max_latitude, min_longitude, max_longitude, is_current, is_deprecated)
		VALUES (?, NULL, ?, 'locality', ?, 60, 22, 59.5, 60.5, 21.5, 22.5, -1, 0)
	`)
	const insertName = opts?.omitOfficialColumn
		? db.prepare(`INSERT INTO names (id, language, name) VALUES (?, ?, ?)`)
		: db.prepare(`INSERT INTO names (id, language, name, official) VALUES (?, ?, ?, ?)`)
	const insertPop = db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`)
	const run = (id: number, language: string, name: string, official: number): void => {
		if (opts?.omitOfficialColumn) insertName.run(id, language, name)
		else insertName.run(id, language, name, official)
	}

	for (const p of places) {
		insertSpr.run(p.id, p.name, p.country)
		run(p.id, "", p.name, 0)

		for (const a of p.aliases ?? []) run(p.id, "", a, 0)

		for (const a of p.officialAliases ?? []) run(p.id, "swe", a, 1)

		if (p.population !== undefined) insertPop.run(p.id, p.population)
	}

	return db
}

// Turku holds "Åbo" as its OFFICIAL Swedish name; the hamlet holds "Åbo" as its own primary. Under
// the plain #912 sub-tier the hamlet's primary wins; under option 3 Turku joins the name-exact
// sub-tier and its population decides.
const TURKU_ABO: SeedPlace[] = [
	{ id: 1, name: "Åbo", country: "SE", population: 300 },
	{ id: 2, name: "Turku", country: "FI", population: 207_000, officialAliases: ["Åbo"] },
]

const FLAG_ON: Partial<RankingWeights> = { officialNameExact: true }

let lookup: WOFSqlitePlaceLookup
afterEach(() => lookup?.close())

describe("findPlace — officialNameExact (#936 option 3)", () => {
	test("flag OFF (explicit): the hamlet's own name beats Turku's official alias — the pre-#936 behavior", async () => {
		lookup = new WOFSqlitePlaceLookup({ database: buildDB(TURKU_ABO), buildFTS: true }, { officialNameExact: false })
		const results = await lookup.findPlace({ text: "Åbo", placetype: "locality" })

		expect(results.length).toBeGreaterThan(1)
		expect(results[0]!.id).toBe(1)
	})

	test("DEFAULT (flag ON since the 2026-07-03 promote): Turku's official name joins the name-exact sub-tier", async () => {
		lookup = new WOFSqlitePlaceLookup({ database: buildDB(TURKU_ABO), buildFTS: true })
		const results = await lookup.findPlace({ text: "Åbo", placetype: "locality" })

		expect(results[0]!.id).toBe(2)
		expect(results[0]!.name).toBe("Turku")
	})

	test("holder below the population floor stays alias-tier (the junk-tier guard)", async () => {
		lookup = new WOFSqlitePlaceLookup(
			{ database: buildDB(TURKU_ABO), buildFTS: true },
			{ officialNameExact: true, officialNameExactFloor: 500_000 }
		)
		const results = await lookup.findPlace({ text: "Åbo", placetype: "locality" })

		expect(results[0]!.id).toBe(1)
	})

	test("a plain (non-official) alias still loses to the name holder — Paris Township stays down", async () => {
		lookup = new WOFSqlitePlaceLookup(
			{
				database: buildDB([
					{ id: 10, name: "Paris", country: "FR", population: 2_100_000 },
					{ id: 11, name: "Paris Township", country: "US", population: 150_000, aliases: ["Paris"] },
				]),
				buildFTS: true,
			},
			FLAG_ON
		)
		const results = await lookup.findPlace({ text: "Paris", placetype: "locality" })

		expect(results[0]!.id).toBe(10)
	})

	test("official alias of the SMALLER place cannot demote the bigger name holder (population within tier)", async () => {
		lookup = new WOFSqlitePlaceLookup(
			{
				database: buildDB([
					{ id: 20, name: "Córdoba", country: "AR", population: 2_106_734 },
					{ id: 21, name: "Cordoba", country: "ES", population: 328_841, officialAliases: ["Córdoba"] },
				]),
				buildFTS: true,
			},
			FLAG_ON
		)
		const results = await lookup.findPlace({ text: "Córdoba", placetype: "locality" })

		expect(results[0]!.id).toBe(20)
	})

	test("pre-#940 gazetteer (no official column) fails soft: flag ON behaves as OFF", async () => {
		lookup = new WOFSqlitePlaceLookup(
			{ database: buildDB(TURKU_ABO, { omitOfficialColumn: true }), buildFTS: true },
			FLAG_ON
		)
		const results = await lookup.findPlace({ text: "Åbo", placetype: "locality" })

		expect(results[0]!.id).toBe(1)
	})
})
