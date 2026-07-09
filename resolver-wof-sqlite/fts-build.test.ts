/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Behavioral tests for `buildPlaceSearchFTS` — formerly exercised through the retired
 *   `mailwoman-wof-build-fts` bin (Pastel Phase 3 absorbed it into `mailwoman gazetteer build
 *   fts`); the build/no-op/rebuild semantics belong to the module, so the tests target it directly.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildPlaceSearchFTS, placeSearchFTSExists } from "./fts.ts"

let scratch: string

function buildFixtureDB(path: string): DatabaseSync {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		INSERT INTO spr VALUES (1, NULL, 'Paris', 'locality', 'FR', 48.85, 2.34, 48.81, 48.90, 2.22, 2.46, -1, 0);
		INSERT INTO spr VALUES (2, NULL, 'Tokyo', 'locality', 'JP', 35.68, 139.69, 35.50, 35.83, 139.34, 139.91, -1, 0);
	`)

	return db
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-wof-fts-build-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("buildPlaceSearchFTS", () => {
	test("builds the index against a fresh DB", () => {
		const db = buildFixtureDB(join(scratch, "fixture.db"))

		try {
			const result = buildPlaceSearchFTS(db)
			expect(result.created).toBe(true)
			expect(result.indexedRows).toBe(2)
			expect(placeSearchFTSExists(db)).toBe(true)
		} finally {
			db.close()
		}
	})

	test("is a no-op when the index already exists", () => {
		const db = buildFixtureDB(join(scratch, "fixture.db"))

		try {
			buildPlaceSearchFTS(db)
			const second = buildPlaceSearchFTS(db)
			expect(second.created).toBe(false)
		} finally {
			db.close()
		}
	})

	test("rebuilds when drop is set", () => {
		const db = buildFixtureDB(join(scratch, "fixture.db"))

		try {
			buildPlaceSearchFTS(db)
			const rebuilt = buildPlaceSearchFTS(db, { drop: true })
			expect(rebuilt.created).toBe(true)
			expect(rebuilt.indexedRows).toBe(2)
		} finally {
			db.close()
		}
	})
})
