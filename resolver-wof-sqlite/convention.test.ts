/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geographic Rule Engine convention model (Direction E, #289). Two layers of tests:
 *
 *   1. The pure engine — `mergeConventions` / `resolveConvention` / `SeedConventionSource`: deep-merge
 *        precedence over a country → region → locality ancestor chain (most-specific wins, weights
 *        merge key-by-key). This is the mechanism the EU locales never exercise (they ride
 *        WORLD_DEFAULT).
 *   2. Live dispatch — a `WofSqlitePlaceLookup` with an INJECTED convention, keyed by the country's WOF
 *        id, proving the merged convention actually reroutes `findPlace`'s strategy dispatch.
 */
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	type Convention,
	mergeConventions,
	resolveConvention,
	SeedConventionSource,
	WORLD_DEFAULT,
} from "./convention.js"
import { WofSqlitePlaceLookup } from "./lookup.js"

describe("convention engine — merge + resolve", () => {
	it("WORLD_DEFAULT reproduces the pre-engine coordinate-first dispatch", () => {
		expect(WORLD_DEFAULT.candidateStrategies).toEqual(["postcode_area_resolution", "fallback_fuzzy_name_match"])
		expect(WORLD_DEFAULT.scoringWeights).toEqual({ pc: 0.6, name: 0.3, pop: 0.1 })
	})

	it("replaces candidateStrategies wholesale (a convention names its full list, never appends)", () => {
		const out = mergeConventions(WORLD_DEFAULT, {
			candidateStrategies: ["digital_code_lookup", "postcode_area_resolution"],
		})
		expect(out.candidateStrategies).toEqual(["digital_code_lookup", "postcode_area_resolution"])
	})

	it("merges scoringWeights key-by-key so a layer can nudge one weight and inherit the rest", () => {
		const merged = resolveConvention(new SeedConventionSource({ 1: { scoringWeights: { pc: 0.8 } } }), [1])
		expect(merged.scoringWeights).toEqual({ pc: 0.8, name: 0.3, pop: 0.1 })
	})

	it("ignores undefined layers (an ancestor with no override row)", () => {
		const out = mergeConventions(WORLD_DEFAULT, undefined, { scoringWeights: { name: 0.5 } }, undefined)
		expect(out.candidateStrategies).toEqual(WORLD_DEFAULT.candidateStrategies)
		expect(out.scoringWeights).toEqual({ pc: 0.6, name: 0.5, pop: 0.1 })
	})

	it("an empty ancestor chain resolves to WORLD_DEFAULT (the EU locales' path)", () => {
		const out = resolveConvention(new SeedConventionSource(), [])
		expect(out).toEqual(WORLD_DEFAULT)
	})

	it("deep-merges country → region → locality with most-specific winning", () => {
		// country sets a base strategy list + pc weight; region overrides the strategy list; locality
		// nudges name weight. The resolved convention reflects the most-specific value per field.
		const source = new SeedConventionSource({
			100: { candidateStrategies: ["postcode_area_resolution"], scoringWeights: { pc: 0.7 } }, // country (JP)
			200: { candidateStrategies: ["grid_interpolation", "postcode_area_resolution"] }, // region (Hokkaido)
			300: { scoringWeights: { name: 0.4 } }, // locality (Sapporo)
		} satisfies Record<number, Convention>)
		// chain ordered MOST-GENERAL → MOST-SPECIFIC
		const out = resolveConvention(source, [100, 200, 300])
		expect(out.candidateStrategies).toEqual(["grid_interpolation", "postcode_area_resolution"]) // region won
		expect(out.scoringWeights).toEqual({ pc: 0.7, name: 0.4, pop: 0.1 }) // country pc + locality name + base pop
	})

	it("SeedConventionSource returns rows by id and undefined for misses", () => {
		const src = new SeedConventionSource({ 42: { candidateStrategies: ["x"] } })
		expect(src.get(42)).toEqual({ candidateStrategies: ["x"] })
		expect(src.get(99)).toBeUndefined()
	})
})

// --- Live dispatch: an injected convention reroutes findPlace -------------------------------------

function buildDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, language TEXT, name TEXT NOT NULL);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER);
		CREATE TABLE postcode_locality (postcode TEXT, country TEXT, locality_id INTEGER, locality_name TEXT,
			aliases TEXT, distance_km REAL, is_containing INTEGER);
	`)
	const spr = db.prepare(
		`INSERT INTO spr (id,parent_id,name,placetype,country,latitude,longitude,min_latitude,max_latitude,min_longitude,max_longitude,is_current,is_deprecated)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,-1,0)`
	)
	// id 90 is the DE country polygon (the convention key); 3 is the small Saxon town "Plauen".
	spr.run(90, 0, "Germany", "country", "DE", 51.0, 10.0, 47.0, 55.0, 6.0, 15.0)
	spr.run(3, 90, "Plauen", "locality", "DE", 50.49, 12.14, 50.4, 50.6, 12.0, 12.3)
	db.prepare(`INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)`).run("08523", "DE", 3, "Plauen", "", 0.0, 1)
	return db
}

describe("convention engine — live dispatch", () => {
	let db: DatabaseSync
	beforeEach(() => {
		db = buildDb()
	})
	afterEach(() => {
		// lookup.close() in each test closes db; nothing else to do.
	})

	it("default (empty source) → coordinate-first recovers the postcode's town from a typo", async () => {
		const lookup = new WofSqlitePlaceLookup({ database: db, buildFts: true })
		// "Plaun" won't FTS-match; postcode_area_resolution injects Plauen from the postcode.
		const r = await lookup.findPlace({ text: "Plaun", placetype: "locality", postcode: "08523", country: "DE" })
		expect(r[0]?.name).toBe("Plauen")
		lookup.close()
	})

	it("an injected country convention that drops postcode_area_resolution reroutes dispatch", async () => {
		// Key the convention by the DE country WOF id (90). Removing postcode_area_resolution from the
		// strategy list means the typo no longer recovers Plauen — proof the merged convention controls
		// findPlace dispatch through the live country → WOF-id → convention path.
		const lookup = new WofSqlitePlaceLookup({
			database: db,
			buildFts: true,
			conventions: { 90: { candidateStrategies: ["fallback_fuzzy_name_match"] } },
		})
		const r = await lookup.findPlace({ text: "Plaun", placetype: "locality", postcode: "08523", country: "DE" })
		expect(r[0]?.name).not.toBe("Plauen")
		lookup.close()
	})
})
