/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the FTS5 sanitizer. The function isn't exported (it lives inside `lookup.ts`), so we
 *   drive it through real `findPlace` calls against a tiny fixture DB and assert on the
 *   `place_search MATCH` behavior. This also catches the case where the sanitizer produces SQL
 *   that's syntactically valid but logically wrong.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { WOFSqlitePlaceLookup } from "./lookup.js"

function buildFixtureDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		INSERT INTO spr VALUES (1, NULL, '62701', 'postalcode', 'US', 39.80, -89.65, 39.78, 39.82, -89.67, -89.63, -1, 0);
		INSERT INTO spr VALUES (2, NULL, '62702', 'postalcode', 'US', 39.82, -89.63, 39.80, 39.84, -89.65, -89.61, -1, 0);
		INSERT INTO spr VALUES (3, NULL, '62721', 'postalcode', 'US', 39.78, -89.66, 39.76, 39.80, -89.68, -89.64, -1, 0);
		INSERT INTO spr VALUES (4, NULL, '90210', 'postalcode', 'US', 34.07, -118.41, 34.05, 34.09, -118.43, -118.39, -1, 0);
		INSERT INTO spr VALUES (5, NULL, 'Paris', 'locality', 'FR', 48.85, 2.34, 48.81, 48.90, 2.22, 2.46, -1, 0);
		INSERT INTO spr VALUES (6, NULL, 'St. Petersburg', 'locality', 'US', 27.77, -82.64, 27.66, 27.85, -82.78, -82.51, -1, 0);
	`)

	return db
}

let lookup: WOFSqlitePlaceLookup

beforeEach(() => {
	lookup = new WOFSqlitePlaceLookup({ database: buildFixtureDb(), buildFTS: true })
})

afterEach(() => {
	lookup.close()
})

describe("sanitizeFTSQuery — trailing-* prefix support", () => {
	test("exact-match (no trailing *) still works (phrase)", async () => {
		const r = await lookup.findPlace({ text: "62701", placetype: "postalcode" })
		expect(r.length).toBe(1)
		expect(r[0]?.name).toBe("62701")
	})

	test("trailing * returns all postcodes starting with the prefix", async () => {
		const r = await lookup.findPlace({ text: "627*", placetype: "postalcode", limit: 10 })
		const names = new Set(r.map((c) => c.name))
		expect(names).toContain("62701")
		expect(names).toContain("62702")
		expect(names).toContain("62721")
		// 90210 starts with 9; should NOT match
		expect(names).not.toContain("90210")
	})

	test("longer prefix narrows the result set", async () => {
		const r627 = await lookup.findPlace({ text: "627*", placetype: "postalcode", limit: 10 })
		const r6270 = await lookup.findPlace({ text: "6270*", placetype: "postalcode", limit: 10 })
		expect(r627.length).toBeGreaterThan(r6270.length)
		expect(r6270.length).toBeGreaterThan(0)
	})

	test("prefix that matches nothing returns empty", async () => {
		expect(await lookup.findPlace({ text: "999*", placetype: "postalcode" })).toEqual([])
	})

	test('phrase + prefix in one query (mixed): `Pari* TX` is `Pari* AND "TX"`', async () => {
		// The fixture has Paris (FR) but no TX; the AND of `Pari*` (matches Paris) AND `"TX"` (matches
		// nothing in the fixture) returns empty.
		const r = await lookup.findPlace({ text: "Pari* TX", placetype: "locality" })
		expect(r).toEqual([])
		// But bare `Pari*` matches Paris.
		const justPrefix = await lookup.findPlace({ text: "Pari*", placetype: "locality" })
		expect(justPrefix.length).toBe(1)
		expect(justPrefix[0]?.name).toBe("Paris")
	})
})

describe("sanitizeFTSQuery — punctuation stripping (existing behavior, regression backstop)", () => {
	test("apostrophes are stripped — `St. (Petersburg)` becomes two phrases AND-joined", async () => {
		// Both `St` and `Petersburg` (as standalone tokens) must match the name `St. Petersburg`.
		// FTS5 tokenizes the name on whitespace (after stripping punctuation by the unicode61
		// tokenizer), so `St` matches `St.` and `Petersburg` matches `Petersburg`.
		const r = await lookup.findPlace({ text: "St. (Petersburg)", placetype: "locality" })
		expect(r.length).toBe(1)
		expect(r[0]?.name).toBe("St. Petersburg")
	})

	test("lone `*` is dropped (no body — no tokens emitted)", async () => {
		expect(await lookup.findPlace({ text: "*", placetype: "postalcode" })).toEqual([])
	})

	test("`abc*xyz*` strips embedded * and keeps trailing → prefix `abcxyz*`", async () => {
		// Confirm no crash from embedded asterisks; assertion is just "no SQL error". Result depends on
		// fixture; here the prefix doesn't match anything.
		await expect(lookup.findPlace({ text: "abc*xyz*", placetype: "postalcode" })).resolves.toBeInstanceOf(Array)
	})
})
