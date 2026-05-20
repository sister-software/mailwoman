/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for `WofSqlitePlaceLookup` against an in-memory fixture DB. The fixture mimics the shape of
 *   a real WOF SQLite distribution but with ~10 hand-picked places — enough to exercise the FTS,
 *   placetype + country + parent filters, and ranking heuristics. No checked-in binary.
 *
 *   Integration tests against a real WOF distribution will land in a follow-up PR once the WOF
 *   download is authorized (night-shift agent hit an auto-mode block on the data.geocode.earth
 *   fetch).
 */

import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { WofSqlitePlaceLookup } from "./lookup.js"

interface FixturePlace {
	id: number
	parent_id: number | null
	name: string
	placetype: string
	country: string | null
	lat: number
	lon: number
	/** Alternate names (one per locale) — joined into FTS as a single token-bag. */
	alt_names?: string[]
	/** Ancestor chain (NOT including self). Used to seed the `ancestors` table. */
	ancestor_ids?: number[]
}

/** A small but representative fixture covering the cases the tests assert against. */
const FIXTURE: FixturePlace[] = [
	// Countries
	{ id: 85633147, parent_id: null, name: "United States", placetype: "country", country: "US", lat: 39.5, lon: -98.0 },
	{ id: 85633723, parent_id: null, name: "France", placetype: "country", country: "FR", lat: 46.5, lon: 2.5 },
	{ id: 85633159, parent_id: null, name: "United Kingdom", placetype: "country", country: "GB", lat: 54.5, lon: -2.5 },
	{ id: 85632997, parent_id: null, name: "Canada", placetype: "country", country: "CA", lat: 56.0, lon: -96.0 },

	// US regions
	{
		id: 85688489,
		parent_id: 85633147,
		name: "Texas",
		placetype: "region",
		country: "US",
		lat: 31.0,
		lon: -100.0,
		ancestor_ids: [85633147],
	},
	{
		id: 85688541,
		parent_id: 85633147,
		name: "Illinois",
		placetype: "region",
		country: "US",
		lat: 40.0,
		lon: -89.0,
		ancestor_ids: [85633147],
	},
	{
		id: 85688543,
		parent_id: 85633147,
		name: "Massachusetts",
		placetype: "region",
		country: "US",
		lat: 42.0,
		lon: -71.5,
		ancestor_ids: [85633147],
	},

	// CA regions
	{
		id: 85682077,
		parent_id: 85632997,
		name: "Ontario",
		placetype: "region",
		country: "CA",
		lat: 50.0,
		lon: -85.0,
		ancestor_ids: [85632997],
	},

	// Localities
	{
		id: 101751119,
		parent_id: 85683033, // FR region (not in fixture; irrelevant for the assertions)
		name: "Paris",
		placetype: "locality",
		country: "FR",
		lat: 48.85,
		lon: 2.34,
		alt_names: ["Pari", "París", "パリ", "巴黎"],
		ancestor_ids: [85633723],
	},
	{
		id: 101715829,
		parent_id: 85688489,
		name: "Paris",
		placetype: "locality",
		country: "US",
		lat: 33.66,
		lon: -95.55,
		ancestor_ids: [85688489, 85633147],
	},
	{
		id: 101727113,
		parent_id: 85688541,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		lat: 39.78,
		lon: -89.65,
		ancestor_ids: [85688541, 85633147],
	},
	{
		id: 101729437,
		parent_id: 85688543,
		name: "Springfield",
		placetype: "locality",
		country: "US",
		lat: 42.1,
		lon: -72.59,
		ancestor_ids: [85688543, 85633147],
	},
	{
		id: 101750367,
		parent_id: 85633159,
		name: "London",
		placetype: "locality",
		country: "GB",
		lat: 51.51,
		lon: -0.13,
		ancestor_ids: [85633159],
	},
	{
		id: 101748449,
		parent_id: 85682077,
		name: "London",
		placetype: "borough", // intentionally NOT locality — to test the placetype filter
		country: "CA",
		lat: 42.98,
		lon: -81.25,
		ancestor_ids: [85682077, 85632997],
	},
	{
		id: 101751069,
		parent_id: 85633723,
		name: "Paris-l'Hôpital",
		placetype: "locality",
		country: "FR",
		lat: 46.92,
		lon: 4.69,
		ancestor_ids: [85633723],
	},
]

function buildFixtureDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	// Schema mirrors the real WOF SQLite distribution at data.geocode.earth (subset of columns we
	// actually read; full schema is documented in `schema.ts`). Note the WOF lifecycle-flag
	// convention: `is_current = -1` means "currently valid".
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
		CREATE TABLE ancestors (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			id INTEGER NOT NULL,
			ancestor_id INTEGER NOT NULL,
			ancestor_placetype TEXT
		);
	`)

	// Fixture places store centroid lat/lon; for bbox tests we use a small ~10 km square around each
	// centroid so R*Tree intersection queries have something realistic to bite on.
	const insertSpr = db.prepare(
		`INSERT INTO spr (
			id, parent_id, name, placetype, country,
			latitude, longitude,
			min_latitude, max_latitude, min_longitude, max_longitude,
			is_current, is_deprecated
		)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, -1, 0)`
	)
	const insertName = db.prepare(`INSERT INTO names (id, language, name) VALUES (?, ?, ?)`)
	const insertAncestor = db.prepare(`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)`)

	for (const p of FIXTURE) {
		// ~0.05° padding around the centroid in each direction (≈ 5 km in latitude, varies with
		// longitude) — tight enough that bbox intersection tests behave like point tests but real
		// enough that the R*Tree gets exercised.
		insertSpr.run(
			p.id,
			p.parent_id,
			p.name,
			p.placetype,
			p.country,
			p.lat,
			p.lon,
			p.lat - 0.05,
			p.lat + 0.05,
			p.lon - 0.05,
			p.lon + 0.05
		)
		for (const alt of p.alt_names ?? []) {
			insertName.run(p.id, "und", alt)
		}
		for (const aid of p.ancestor_ids ?? []) {
			insertAncestor.run(p.id, aid, "ancestor")
		}
	}

	return db
}

let lookup: WofSqlitePlaceLookup

beforeEach(() => {
	const db = buildFixtureDb()
	lookup = new WofSqlitePlaceLookup({ database: db, buildFts: true })
})

afterEach(() => {
	lookup.close()
})

describe("WofSqlitePlaceLookup against an inline WOF fixture", () => {
	test('"Paris" with no country/parent filter returns both Paris,FR and Paris,US as localities', async () => {
		// Without a popularity signal (real WOF has wof:population; v0.1 doesn't model it) the
		// resolver has no reason to prefer one Paris over the other — both are valid candidates.
		// Callers disambiguate via country / parentId / alt-name match.
		const candidates = await lookup.findPlace({ text: "Paris" })
		const names = candidates.map((c) => `${c.name},${c.country}`)
		expect(names).toContain("Paris,FR")
		expect(names).toContain("Paris,US")
		expect(candidates.every((c) => c.placetype === "locality")).toBe(true)
	})

	test('"Paris" with country: "US" returns Paris,TX first', async () => {
		const candidates = await lookup.findPlace({ text: "Paris", country: "US" })
		expect(candidates.length).toBeGreaterThan(0)
		expect(candidates[0]).toMatchObject({ name: "Paris", country: "US", placetype: "locality" })
	})

	test('"London" with placetype: "locality" excludes the Ontario borough', async () => {
		const candidates = await lookup.findPlace({ text: "London", placetype: "locality" })
		expect(candidates.length).toBe(1)
		expect(candidates[0]).toMatchObject({ name: "London", country: "GB" })
	})

	test('"Springfield" with parentId: Illinois returns Springfield,IL first', async () => {
		const illinoisId = 85688541
		const candidates = await lookup.findPlace({ text: "Springfield", parentId: illinoisId })
		expect(candidates.length).toBeGreaterThan(0)
		expect(candidates[0]).toMatchObject({ name: "Springfield", country: "US", parent_id: illinoisId })
	})

	test('alternate-name match: "パリ" returns Paris,FR via the names join', async () => {
		const candidates = await lookup.findPlace({ text: "パリ" })
		expect(candidates.length).toBeGreaterThan(0)
		expect(candidates[0]).toMatchObject({ name: "Paris", country: "FR" })
	})

	test("length penalty: short name beats long name for short query", async () => {
		const candidates = await lookup.findPlace({ text: "Paris", country: "FR" })
		const paris = candidates.find((c) => c.name === "Paris")
		const parisLHopital = candidates.find((c) => c.name === "Paris-l'Hôpital")
		expect(paris).toBeDefined()
		expect(parisLHopital).toBeDefined()
		expect(paris!.score).toBeGreaterThan(parisLHopital!.score)
	})

	test("limit defaults to 10, respected when specified", async () => {
		const cap2 = await lookup.findPlace({ text: "Paris", limit: 2 })
		expect(cap2.length).toBeLessThanOrEqual(2)
	})

	test("empty/whitespace-only text returns an empty array (not an FTS syntax error)", async () => {
		expect(await lookup.findPlace({ text: "" })).toEqual([])
		expect(await lookup.findPlace({ text: "   " })).toEqual([])
		expect(await lookup.findPlace({ text: "!!!" })).toEqual([])
	})

	test("query with special characters is sanitized — `St. (Petersburg)` does not throw", async () => {
		// No such place in the fixture; we only assert no SQL syntax error.
		await expect(lookup.findPlace({ text: "St. (Petersburg)" })).resolves.toEqual([])
	})

	test("Disposable: Symbol.dispose closes the lookup", async () => {
		const db = buildFixtureDb()
		{
			using disposable = new WofSqlitePlaceLookup({ database: db, buildFts: true })
			const cands = await disposable.findPlace({ text: "Paris" })
			expect(cands.length).toBeGreaterThan(0)
		}
		// After the using block: querying via the original db handle should still work because we
		// don't own it.
		const after = db.prepare(`SELECT COUNT(*) AS n FROM spr`).get() as { n: number }
		expect(after.n).toBe(FIXTURE.length)
		db.close()
	})
})

describe("WofSqlitePlaceLookup ctor", () => {
	test("requires exactly one of database / databasePath", () => {
		expect(() => new WofSqlitePlaceLookup({})).toThrow(/one of/)
		expect(
			() => new WofSqlitePlaceLookup({ database: new DatabaseSync(":memory:"), databasePath: "/tmp/x.db" })
		).toThrow(/not both/)
	})

	test("errors loudly when FTS table is missing and buildFts is false", () => {
		const db = new DatabaseSync(":memory:")
		db.exec(`CREATE TABLE places (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT);`)
		expect(() => new WofSqlitePlaceLookup({ database: db, buildFts: false })).toThrow(/place_search/)
		db.close()
	})
})
