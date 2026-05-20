/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the FTS5 build helpers used by both `WofSqlitePlaceLookup` and the
 *   `mailwoman-wof-build-fts` CLI.
 */

import { DatabaseSync } from "node:sqlite"
import { describe, expect, test } from "vitest"

import { buildPlaceSearchFts, PLACE_SEARCH_TABLE, placeSearchFtsExists } from "./fts.js"

function buildBaseSchema(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE places (
			id INTEGER PRIMARY KEY,
			parent_id INTEGER,
			name TEXT NOT NULL,
			placetype TEXT NOT NULL,
			country TEXT
		);
		CREATE TABLE names (
			rowid INTEGER PRIMARY KEY,
			place_id INTEGER NOT NULL,
			language TEXT NOT NULL,
			kind TEXT NOT NULL,
			name TEXT NOT NULL
		);
		INSERT INTO places VALUES (1, NULL, 'Paris', 'locality', 'FR');
		INSERT INTO places VALUES (2, NULL, 'Springfield', 'locality', 'US');
		INSERT INTO places VALUES (3, NULL, 'London', 'locality', 'GB');
		INSERT INTO names (place_id, language, kind, name) VALUES (1, 'und', 'variant', 'パリ');
		INSERT INTO names (place_id, language, kind, name) VALUES (1, 'und', 'variant', 'París');
	`)
	return db
}

describe("buildPlaceSearchFts", () => {
	test("builds the place_search virtual table from a fresh DB", () => {
		const db = buildBaseSchema()
		expect(placeSearchFtsExists(db)).toBe(false)

		const result = buildPlaceSearchFts(db)
		expect(result.created).toBe(true)
		expect(result.indexedRows).toBe(3)
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
		expect(placeSearchFtsExists(db)).toBe(true)

		db.close()
	})

	test("is a no-op when the table already exists and drop is false", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFts(db)

		const result = buildPlaceSearchFts(db)
		expect(result.created).toBe(false)
		expect(result.indexedRows).toBe(3)

		db.close()
	})

	test("rebuilds when drop is true", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFts(db)

		// Add a new place but don't reindex yet — count should still be the original 3.
		db.exec(`INSERT INTO places VALUES (4, NULL, 'Tokyo', 'locality', 'JP');`)
		expect((db.prepare(`SELECT COUNT(*) AS n FROM ${PLACE_SEARCH_TABLE}`).get() as { n: number }).n).toBe(3)

		const result = buildPlaceSearchFts(db, { drop: true })
		expect(result.created).toBe(true)
		expect(result.indexedRows).toBe(4)

		db.close()
	})

	test("concatenates alt_names from the names table into the FTS document", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFts(db)

		const row = db.prepare(`SELECT name, alt_names FROM ${PLACE_SEARCH_TABLE} WHERE wof_id = 1`).get() as {
			name: string
			alt_names: string
		}
		expect(row.name).toBe("Paris")
		expect(row.alt_names).toContain("パリ")
		expect(row.alt_names).toContain("París")

		db.close()
	})

	test("MATCH query works against the built index", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFts(db)

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
		buildPlaceSearchFts(db, { onProgress: (phase) => phases.push(phase) })
		expect(phases).toEqual(["checking", "creating", "populating", "done"])
		db.close()
	})

	test("invokes onProgress with the dropping phase when --drop is used", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFts(db)
		const phases: string[] = []
		buildPlaceSearchFts(db, { drop: true, onProgress: (phase) => phases.push(phase) })
		expect(phases).toEqual(["checking", "dropping", "creating", "populating", "done"])
		db.close()
	})

	test("onProgress receives a detail string for the done phase", () => {
		const db = buildBaseSchema()
		let doneDetail: string | undefined
		buildPlaceSearchFts(db, {
			onProgress: (phase, detail) => {
				if (phase === "done") doneDetail = detail
			},
		})
		expect(doneDetail).toMatch(/3 rows indexed/)
		db.close()
	})
})

describe("placeSearchFtsExists", () => {
	test("returns false when the table is absent", () => {
		const db = buildBaseSchema()
		expect(placeSearchFtsExists(db)).toBe(false)
		db.close()
	})

	test("returns true once the table is built", () => {
		const db = buildBaseSchema()
		buildPlaceSearchFts(db)
		expect(placeSearchFtsExists(db)).toBe(true)
		db.close()
	})
})
