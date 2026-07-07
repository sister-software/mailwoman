/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the FTS5 build helpers used by both `WOFSqlitePlaceLookup` and the
 *   `mailwoman-wof-build-fts` CLI.
 */

import { DatabaseSync } from "node:sqlite"

import { describe, expect, test } from "vitest"

import {
	ALIAS_SEPARATOR,
	aliasBagExactMatch,
	buildPlaceSearchFTS,
	PLACE_SEARCH_TABLE,
	placeSearchFTSExists,
} from "./fts.js"

function buildBaseSchema(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	// Mirror the real WOF SQLite schema subset that fts.ts queries. Includes the bbox columns
	// (min_latitude/max_latitude/min_longitude/max_longitude) the R*Tree builder reads.
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY,
			parent_id INTEGER,
			name TEXT,
			placetype TEXT,
			country TEXT,
			latitude REAL,
			longitude REAL,
			min_latitude REAL,
			max_latitude REAL,
			min_longitude REAL,
			max_longitude REAL,
			is_current INTEGER,
			is_deprecated INTEGER
		);
		CREATE TABLE names (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			id INTEGER NOT NULL,
			language TEXT,
			name TEXT NOT NULL
		);
		-- (id, parent_id, name, placetype, country, lat, lon, minLat, maxLat, minLon, maxLon, is_current, is_deprecated)
		INSERT INTO spr VALUES (1, NULL, 'Paris', 'locality', 'FR', 48.85, 2.34, 48.81, 48.90, 2.22, 2.46, -1, 0);
		INSERT INTO spr VALUES (2, NULL, 'Springfield', 'locality', 'US', 39.78, -89.65, 39.70, 39.86, -89.74, -89.56, -1, 0);
		INSERT INTO spr VALUES (3, NULL, 'London', 'locality', 'GB', 51.51, -0.13, 51.28, 51.69, -0.51, 0.33, -1, 0);
		INSERT INTO names (id, language, name) VALUES (1, 'und', 'パリ');
		INSERT INTO names (id, language, name) VALUES (1, 'und', 'París');
	`)

	return db
}

describe("buildPlaceSearchFTS", () => {
	test("builds the place_search virtual table from a fresh DB", () => {
		const db = buildBaseSchema()
		expect(placeSearchFTSExists(db)).toBe(false)

		const result = buildPlaceSearchFTS(db)
		expect(result.created).toBe(true)
		expect(result.indexedRows).toBe(3)
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
		expect(placeSearchFTSExists(db)).toBe(true)

		db.close()
	})

	test("is a no-op when the table already exists and drop is false", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)

		const result = buildPlaceSearchFTS(db)
		expect(result.created).toBe(false)
		expect(result.indexedRows).toBe(3)

		db.close()
	})

	test("rebuilds when drop is true", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)

		// Add a new place but don't reindex yet — count should still be the original 3.
		db.exec(`
			INSERT INTO spr VALUES (4, NULL, 'Tokyo', 'locality', 'JP', 35.68, 139.69, 35.50, 35.83, 139.34, 139.91, -1, 0);
		`)
		expect((db.prepare(`SELECT COUNT(*) AS n FROM ${PLACE_SEARCH_TABLE}`).get() as { n: number }).n).toBe(3)

		const result = buildPlaceSearchFTS(db, { drop: true })
		expect(result.created).toBe(true)
		expect(result.indexedRows).toBe(4)

		db.close()
	})

	test("concatenates alt_names from the names table into the FTS document", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)

		const row = db.prepare(`SELECT name, alt_names FROM ${PLACE_SEARCH_TABLE} WHERE wof_id = 1`).get() as {
			name: string
			alt_names: string
		}
		expect(row.name).toBe("Paris")
		expect(row.alt_names).toContain("パリ")
		expect(row.alt_names).toContain("París")

		db.close()
	})

	test("joins aliases with the boundary-preserving ALIAS_SEPARATOR token (#523)", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)

		const row = db.prepare(`SELECT alt_names FROM ${PLACE_SEARCH_TABLE} WHERE wof_id = 1`).get() as {
			alt_names: string
		}
		// One boundary between the two aliases (space-padded so each alias tokenizes normally) plus
		// the trailing format marker that distinguishes new bags from legacy single-alias ones.
		expect(row.alt_names).toBe(`パリ ${ALIAS_SEPARATOR} París ${ALIAS_SEPARATOR}`)

		db.close()
	})

	test("a phrase query cannot match ACROSS two aliases' concatenation boundary (#523)", () => {
		const db = buildBaseSchema()
		// Two aliases whose concatenation forms a third phrase: the bag "York <sep> New City" must
		// not phrase-match "york new". Without the separator token, FTS5 assigns the aliases' tokens
		// consecutive positions and the cross-boundary phrase falsely matches (see the ALIAS_SEPARATOR
		// probe table in fts.ts — punctuation separators do NOT fix this; only an indexed token does).
		db.exec(`
			INSERT INTO spr VALUES (5, NULL, 'Twin Hamlet', 'locality', 'US', 40.0, -80.0, 39.9, 40.1, -80.1, -79.9, -1, 0);
			INSERT INTO names (id, language, name) VALUES (5, 'eng', 'York');
			INSERT INTO names (id, language, name) VALUES (5, 'eng', 'New City');
		`)
		buildPlaceSearchFTS(db)

		const match = (q: string): number[] =>
			(
				db.prepare(`SELECT wof_id FROM ${PLACE_SEARCH_TABLE} WHERE ${PLACE_SEARCH_TABLE} MATCH ?`).all(q) as {
					wof_id: number
				}[]
			).map((r) => r.wof_id)

		expect(match('"york new"')).toEqual([]) // the false cross-boundary phrase
		expect(match('"york"')).toEqual([5]) // each alias is still individually matchable
		expect(match('"new city"')).toEqual([5])

		db.close()
	})

	test("strips an embedded U+E000 from source names so a poisoned row can't forge an alias boundary (#523)", () => {
		const db = buildBaseSchema()
		db.exec(`
			INSERT INTO spr VALUES (6, NULL, 'Honest Place', 'locality', 'US', 41.0, -81.0, 40.9, 41.1, -81.1, -80.9, -1, 0);
		`)
		db.prepare(`INSERT INTO names (id, language, name) VALUES (6, 'eng', ?)`).run(`Evil${ALIAS_SEPARATOR}Name`)
		buildPlaceSearchFTS(db)

		const row = db.prepare(`SELECT alt_names FROM ${PLACE_SEARCH_TABLE} WHERE wof_id = 6`).get() as {
			alt_names: string
		}
		// Flattened to a space — ONE alias (plus the trailing format marker), no forged boundary.
		expect(row.alt_names).toBe(`Evil Name ${ALIAS_SEPARATOR}`)
		expect(aliasBagExactMatch(row.alt_names, "evil", false)).toBe(false) // fragment ≠ exact
		expect(aliasBagExactMatch(row.alt_names, "evil name", false)).toBe(true) // the whole alias is

		db.close()
	})

	test("MATCH query works against the built index", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)

		const rows = db
			.prepare(`SELECT wof_id FROM ${PLACE_SEARCH_TABLE} WHERE ${PLACE_SEARCH_TABLE} MATCH ?`)
			.all('"Paris"') as { wof_id: number }[]
		expect(rows.length).toBe(1)
		expect(rows[0]?.wof_id).toBe(1)

		const altRows = db
			.prepare(`SELECT wof_id FROM ${PLACE_SEARCH_TABLE} WHERE ${PLACE_SEARCH_TABLE} MATCH ?`)
			.all('"パリ"') as { wof_id: number }[]
		expect(altRows.length).toBe(1)
		expect(altRows[0]?.wof_id).toBe(1)

		db.close()
	})

	test("invokes onProgress for each phase on a fresh build", () => {
		const db = buildBaseSchema()
		const phases: string[] = []
		buildPlaceSearchFTS(db, { onProgress: (phase) => phases.push(phase) })
		expect(phases).toEqual(["checking", "creating", "populating", "creating-bbox", "populating-bbox", "done"])
		db.close()
	})

	test("invokes onProgress with the dropping phase when --drop is used (twice — once per index)", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)
		const phases: string[] = []
		buildPlaceSearchFTS(db, { drop: true, onProgress: (phase) => phases.push(phase) })
		expect(phases).toEqual([
			"checking",
			"dropping", // place_search
			"creating",
			"populating",
			"dropping", // place_bbox
			"creating-bbox",
			"populating-bbox",
			"done",
		])
		db.close()
	})

	test("onProgress receives a detail string for the done phase", () => {
		const db = buildBaseSchema()
		let doneDetail: string | undefined
		buildPlaceSearchFTS(db, {
			onProgress: (phase, detail) => {
				if (phase === "done") {
					doneDetail = detail
				}
			},
		})
		expect(doneDetail).toMatch(/3 FTS rows/)
		expect(doneDetail).toMatch(/3 bbox rows/)
		db.close()
	})

	test("populates the R*Tree bbox table from spr.min_*/max_* columns", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)
		// Paris (id 1) bbox should be present and queryable.
		const hits = db
			.prepare(`SELECT id FROM place_bbox WHERE min_lat <= ? AND max_lat >= ? AND min_lon <= ? AND max_lon >= ?`)
			.all(48.85, 48.85, 2.34, 2.34) as { id: number }[]
		expect(hits.map((h) => h.id)).toContain(1)
		db.close()
	})

	test("indexes places with is_current = 1 (legacy Mapzen-era) as well as is_current = -1 (modern); see #91", () => {
		const db = buildBaseSchema()
		// Add one place tagged with the legacy convention (`is_current = 1`). WOF mixes both
		// conventions; ~42% of admin-US rows carry `1` rather than `-1`. The filter must accept
		// both — the Phase 4.2 regression was excluding all of these.
		db.exec(`
			INSERT INTO spr VALUES (
				1000, NULL, 'Legacy Place', 'locality', 'US',
				40.0, -80.0,
				39.9, 40.1, -80.1, -79.9,
				1, 0  /* is_current = 1 (legacy), is_deprecated = 0 */
			);
		`)
		const result = buildPlaceSearchFTS(db)
		expect(result.indexedRows).toBe(4) // 3 modern + 1 legacy
		// MATCH against the new row to confirm it's actually queryable.
		const hit = db.prepare(`SELECT wof_id FROM place_search WHERE place_search MATCH ?`).get("Legacy Place") as
			| { wof_id: number }
			| undefined
		expect(hit?.wof_id).toBe(1000)
		// Also confirm the bbox row landed in the R*Tree.
		const bboxHit = db.prepare(`SELECT id FROM place_bbox WHERE min_lat <= ? AND max_lat >= ?`).all(40.0, 40.0) as {
			id: number
		}[]
		expect(bboxHit.map((h) => h.id)).toContain(1000)
		db.close()
	})

	test("excludes is_current = 0 places (no-longer-current); see #91", () => {
		const db = buildBaseSchema()
		db.exec(`
			INSERT INTO spr VALUES (
				2000, NULL, 'Phantom Place', 'locality', 'US',
				40.0, -80.0,
				39.9, 40.1, -80.1, -79.9,
				0, 0
			);
		`)
		const result = buildPlaceSearchFTS(db)
		expect(result.indexedRows).toBe(3) // the phantom is excluded
		const hit = db.prepare(`SELECT wof_id FROM place_search WHERE place_search MATCH ?`).get("Phantom") as
			| { wof_id: number }
			| undefined
		expect(hit).toBeUndefined()
		db.close()
	})
})

describe("aliasBagExactMatch", () => {
	const SEP = ALIAS_SEPARATOR
	// What buildPlaceSearchFTS emits for aliases ["York", "New City"] (note the trailing marker).
	const separated = `York ${SEP} New City ${SEP}`

	test("separated bag: per-alias equality, case/whitespace-insensitive", () => {
		expect(aliasBagExactMatch(separated, "york", false)).toBe(true)
		expect(aliasBagExactMatch(separated, "new city", false)).toBe(true)
		expect(aliasBagExactMatch(separated, "city", false)).toBe(false) // interior fragment
		expect(aliasBagExactMatch(separated, "york new", false)).toBe(false) // cross-boundary fragment
	})

	test("separated bag: ungated — an alias match counts even when another candidate is strictly exact", () => {
		expect(aliasBagExactMatch(separated, "new city", true)).toBe(true)
	})

	test("legacy bag (no separator): padded containment, gated on anyStrictExact", () => {
		const legacy = "York New City" // pre-#523 space-joined bag — boundaries lost
		expect(aliasBagExactMatch(legacy, "new city", false)).toBe(true) // historical behavior preserved
		expect(aliasBagExactMatch(legacy, "new city", true)).toBe(false) // the gate
	})

	test("null / empty bag and empty query never match", () => {
		expect(aliasBagExactMatch(null, "york", false)).toBe(false)
		expect(aliasBagExactMatch("", "york", false)).toBe(false)
		expect(aliasBagExactMatch(separated, "", false)).toBe(false)
	})
})

describe("placeSearchFTSExists", () => {
	test("returns false when the table is absent", () => {
		const db = buildBaseSchema()
		expect(placeSearchFTSExists(db)).toBe(false)
		db.close()
	})

	test("returns true once the table is built", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFTS(db)
		expect(placeSearchFTSExists(db)).toBe(true)
		db.close()
	})
})
