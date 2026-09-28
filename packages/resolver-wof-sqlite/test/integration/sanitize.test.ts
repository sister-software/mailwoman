/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the FTS5 sanitizer, which is not exported and is driven through real `findPlace` calls.
 */

import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite/lookup"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

function buildFixtureDB(): DatabaseClient<WOFDatabase> {
	const db = DatabaseClient.temp<WOFDatabase>()

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
		INSERT INTO spr VALUES (7, NULL, 'Thiron-Gardais', 'locality', 'FR', 48.32, 0.99, 48.30, 48.34, 0.97, 1.01, -1, 0);
		INSERT INTO spr VALUES (8, NULL, 'Penne-d''Agenais', 'locality', 'FR', 44.39, 0.87, 44.37, 44.41, 0.85, 0.89, -1, 0);
	`)

	return db
}

let lookup: WOFSQLitePlaceLookup

beforeEach(() => {
	lookup = new WOFSQLitePlaceLookup({ database: buildFixtureDB(), buildFTS: true })
})

afterEach(() => {
	lookup[Symbol.dispose]()
})

describe("sanitizeFTSQuery — trailing-* prefix support", () => {
	test("exact-match (no trailing *) still works (phrase)", async () => {
		const r = await lookup.findPlace({ text: "62701", placetype: "postalcode" })
		expect(r).toHaveLength(1)
		expect(r[0]?.name).toBe("62701")
	})

	test("trailing * returns all postcodes starting with the prefix", async () => {
		const r = await lookup.findPlace({ text: "627*", placetype: "postalcode", limit: 10 })
		const names = new Set(r.map((c) => c.name))
		expect(names).toContain("62701")
		expect(names).toContain("62702")
		expect(names).toContain("62721")
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
		const r = await lookup.findPlace({ text: "Pari* TX", placetype: "locality" })
		expect(r).toEqual([])
		const justPrefix = await lookup.findPlace({ text: "Pari*", placetype: "locality" })
		expect(justPrefix).toHaveLength(1)
		expect(justPrefix[0]?.name).toBe("Paris")
	})
})

describe("sanitizeFTSQuery — punctuation stripping (existing behavior, regression backstop)", () => {
	test("apostrophes are stripped — `St. (Petersburg)` becomes two phrases AND-joined", async () => {
		const r = await lookup.findPlace({ text: "St. (Petersburg)", placetype: "locality" })
		expect(r).toHaveLength(1)
		expect(r[0]?.name).toBe("St. Petersburg")
	})

	test("lone `*` is dropped (no body — no tokens emitted)", async () => {
		expect(await lookup.findPlace({ text: "*", placetype: "postalcode" })).toEqual([])
	})

	test("`abc*xyz*` strips embedded * and keeps trailing → prefix `abcxyz*`", async () => {
		await expect(lookup.findPlace({ text: "abc*xyz*", placetype: "postalcode" })).resolves.toBeInstanceOf(Array)
	})
})

describe("sanitizeFTSQuery — intra-token punctuation SPLITS for non-postcode queries (#945)", () => {
	test("hyphenated locality resolves — `Thiron-Gardais` reaches the FTS as two terms", async () => {
		const r = await lookup.findPlace({ text: "Thiron-Gardais", placetype: "locality" })

		expect(r).toHaveLength(1)
		expect(r[0]?.name).toBe("Thiron-Gardais")
	})

	test("apostrophe + hyphen combined — `Penne-d'Agenais` resolves", async () => {
		const r = await lookup.findPlace({ text: "Penne-d'Agenais", placetype: "locality" })

		expect(r).toHaveLength(1)
		expect(r[0]?.name).toBe("Penne-d'Agenais")
	})

	test("trailing `*` applies to the final split part — `Thiron-Gard*` prefix-matches", async () => {
		const r = await lookup.findPlace({ text: "Thiron-Gard*", placetype: "locality" })

		expect(r).toHaveLength(1)
		expect(r[0]?.name).toBe("Thiron-Gardais")
	})

	test("postcode-typed queries KEEP the #920 fused name-law shape", async () => {
		const r = await lookup.findPlace({ text: "62-701", placetype: "postalcode" })

		expect(r).toHaveLength(1)
		expect(r[0]?.name).toBe("62701")
	})
})
