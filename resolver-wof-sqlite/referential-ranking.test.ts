/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SAINT-DENIS — the canonical test for ROAD_TO_V9 §2's ratified policy: **the geocoder ranks by
 *   referential likelihood; encyclopedic importance is data, never the ranking key.**
 *
 *   THE CASE, with the real numbers from `wof/fst-staging-2026-08-05/admin-global-priority-importance.db`
 *   (read 2026-08-06):
 *
 *   | place                             | wof         | population | encyclopedic |
 *   | --------------------------------- | ----------- | ---------- | ------------ |
 *   | Saint-Denis, Seine-Saint-Denis    | 101751155   | 96,128     | 0.1173       |
 *   | Saint-Denis, Aude                 | 101896431   | 418        | 0.5683       |
 *
 *   Encyclopedic importance ranks the 418-person Aude hamlet **4.8x above** the Paris suburb of 96,128.
 *   A geocoder that ranked on it would answer a bare "Saint-Denis" with a hamlet nobody means. The
 *   fixture below carries BOTH scores in the gazetteer — the suburb's disadvantage on the encyclopedic
 *   column is real and present, not withheld — and asserts the suburb still wins. There is no
 *   hand-written rule, pin, or safelist anywhere in the path: the suburb wins because referential
 *   likelihood is what the ranking reads.
 *
 *   The second half of the file is the D-rule measurement for the split (§2 R1's "expected resolver
 *   delta is ZERO"): every ranking assertion is run against a gazetteer WITHOUT the encyclopedic
 *   column and one WITH it, and the two answer identically. If carrying the score could move a rank,
 *   this is where it would show.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { WOFSqlitePlaceLookup } from "./lookup.ts"
import { referentialFromPopulation } from "./place-importance-schema.ts"

interface FixturePlace {
	id: number
	name: string
	country: string
	lat: number
	lon: number
	population?: number
	/**
	 * The fan-out-guarded Wikipedia score. `undefined` = no article — written as SQL NULL, never 0.
	 */
	encyclopedic?: number
}

/**
 * The two real Saint-Denis bearers plus the Yonne commune that sits between them on both scales — enough to prove the
 * ordering is a ranking and not a two-way coin flip.
 */
const SAINT_DENIS: FixturePlace[] = [
	{
		id: 101_751_155,
		name: "Saint-Denis",
		country: "FR",
		lat: 48.9296,
		lon: 2.3593,
		population: 96_128,
		encyclopedic: 0.1173,
	},
	{
		id: 101_896_431,
		name: "Saint-Denis",
		country: "FR",
		lat: 43.356,
		lon: 2.2177,
		population: 418,
		encyclopedic: 0.5683,
	},
	{
		id: 101_885_711,
		name: "Saint-Denis",
		country: "FR",
		lat: 48.2352,
		lon: 3.2666,
		population: 663,
		encyclopedic: 0.5513,
	},
]

/**
 * Build the fixture gazetteer. `withEncyclopedic` decides whether `place_importance` carries the two-score split's
 * columns at all — the pre-split state (no table) and the post-split state (both columns), which is the pair the
 * zero-delta measurement compares.
 */
function buildFixtureDB(
	places: readonly FixturePlace[],
	{ withEncyclopedic }: { withEncyclopedic: boolean }
): DatabaseSync {
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
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
	`)

	if (withEncyclopedic) {
		db.exec(`
			CREATE TABLE place_importance (
				id INTEGER PRIMARY KEY, referential REAL NOT NULL, encyclopedic REAL, importance REAL NOT NULL
			);
		`)
	}

	const insertSpr = db.prepare(`
		INSERT INTO spr (id, parent_id, name, placetype, country,
		                 latitude, longitude,
		                 min_latitude, max_latitude, min_longitude, max_longitude,
		                 is_current, is_deprecated)
		VALUES (?, NULL, ?, 'locality', ?, ?, ?, ?, ?, ?, ?, -1, 0)
	`)

	const insertPop = db.prepare("INSERT INTO place_population (id, population) VALUES (?, ?)")

	const insertImportance = withEncyclopedic
		? db.prepare("INSERT INTO place_importance (id, referential, encyclopedic, importance) VALUES (?, ?, ?, ?)")
		: undefined

	for (const p of places) {
		insertSpr.run(p.id, p.name, p.country, p.lat, p.lon, p.lat - 0.05, p.lat + 0.05, p.lon - 0.05, p.lon + 0.05)

		if (p.population !== undefined) {
			insertPop.run(p.id, p.population)
		}

		const referential = referentialFromPopulation(p.population)

		insertImportance?.run(p.id, referential, p.encyclopedic ?? null, p.encyclopedic ?? referential)
	}

	return db
}

const open = (places: readonly FixturePlace[], withEncyclopedic: boolean): WOFSqlitePlaceLookup =>
	new WOFSqlitePlaceLookup({ database: buildFixtureDB(places, { withEncyclopedic }), buildFTS: true })

let lookup: WOFSqlitePlaceLookup | undefined

afterEach(() => {
	lookup?.close()
	lookup = undefined
})

describe("Saint-Denis — ranking is referential", () => {
	it("the encyclopedic column really does invert the truth (the premise this test rests on)", () => {
		// Stated as an assertion rather than a comment: if the fixture's numbers ever stop disagreeing,
		// every test below passes vacuously and nobody would notice.
		const suburb = SAINT_DENIS[0]!
		const hamlet = SAINT_DENIS[1]!

		expect(hamlet.encyclopedic!).toBeGreaterThan(suburb.encyclopedic!)
		expect(hamlet.encyclopedic! / suburb.encyclopedic!).toBeGreaterThan(4)
		expect(referentialFromPopulation(suburb.population)).toBeGreaterThan(referentialFromPopulation(hamlet.population))
	})

	it("a bare 'Saint-Denis' resolves to the Seine-Saint-Denis suburb, with both scores in the gazetteer", async () => {
		lookup = open(SAINT_DENIS, true)
		const results = await lookup.findPlace({ text: "Saint-Denis" })

		expect(results[0]!.id).toBe(101_751_155)
		expect(results[0]!.population).toBe(96_128)
	})

	it("carries the encyclopedic score onto the winner without ranking on it", async () => {
		lookup = open(SAINT_DENIS, true)
		const results = await lookup.findPlace({ text: "Saint-Denis" })
		const suburb = results.find((r) => r.id === 101_751_155)!

		// The winner is the one with the LOWER encyclopedic score. Both facts on one object is the whole
		// policy: the score is visible to consumers and inert to the ranking.
		expect(suburb.encyclopedic).toBeCloseTo(0.1173, 4)
		expect(suburb.referential).toBeCloseTo(referentialFromPopulation(96_128), 6)

		for (const other of results.filter((r) => r.id !== 101_751_155)) {
			expect(other.encyclopedic!).toBeGreaterThan(suburb.encyclopedic!)
		}
	})

	it("orders all three bearers referentially, top to bottom", async () => {
		lookup = open(SAINT_DENIS, true)
		const results = await lookup.findPlace({ text: "Saint-Denis" })

		expect(results.map((r) => r.id)).toEqual([101_751_155, 101_885_711, 101_896_431])
		// Encyclopedic order would be very nearly the reverse.
		expect(results.map((r) => r.encyclopedic)).toEqual(results.map((r) => r.encyclopedic).toSorted())
	})

	it("reports NO encyclopedic score when the gazetteer predates the split — absence, not 0", async () => {
		lookup = open(SAINT_DENIS, false)
		const results = await lookup.findPlace({ text: "Saint-Denis" })

		expect(results[0]!.id).toBe(101_751_155)

		for (const r of results) {
			expect(r.encyclopedic).toBeUndefined()
		}
	})
})

describe("D-rule — carrying the encyclopedic score moves no rank", () => {
	/**
	 * §2 R1 predicts a resolver delta of ZERO: the split is schema + plumbing + a carry, and the ranking key it names
	 * (population) is the one the resolver already used. Predicted is not measured, so this measures it — every query
	 * runs against a pre-split gazetteer and a post-split one, and the returned id ORDER must be identical.
	 */
	const QUERIES: ReadonlyArray<{ label: string; text: string }> = [
		{ label: "bare namesake", text: "Saint-Denis" },
		{ label: "case-folded", text: "saint-denis" },
		{ label: "unhyphenated", text: "Saint Denis" },
	]

	for (const { label, text } of QUERIES) {
		it(`${label}: identical ranking with and without the encyclopedic column`, async () => {
			const before = open(SAINT_DENIS, false)
			const after = open(SAINT_DENIS, true)

			try {
				const beforeIDs = (await before.findPlace({ text })).map((r) => r.id)
				const afterIDs = (await after.findPlace({ text })).map((r) => r.id)

				expect(afterIDs).toEqual(beforeIDs)
				expect(beforeIDs.length).toBeGreaterThan(0)
			} finally {
				before.close()
				after.close()
			}
		})
	}

	it("holds when the encyclopedic order is the exact reverse of the referential one", async () => {
		// The adversarial shape: encyclopedic scores assigned in strict inverse-population order. If the
		// carry leaked into ranking anywhere, this fixture inverts the result.
		const inverted: FixturePlace[] = [
			{ ...SAINT_DENIS[0]!, encyclopedic: 0.01 },
			{ ...SAINT_DENIS[1]!, encyclopedic: 0.99 },
			{ ...SAINT_DENIS[2]!, encyclopedic: 0.5 },
		]

		const before = open(SAINT_DENIS, false)
		const after = open(inverted, true)

		try {
			const beforeIDs = (await before.findPlace({ text: "Saint-Denis" })).map((r) => r.id)
			const afterIDs = (await after.findPlace({ text: "Saint-Denis" })).map((r) => r.id)

			expect(afterIDs).toEqual(beforeIDs)
			expect(afterIDs[0]).toBe(101_751_155)
		} finally {
			before.close()
			after.close()
		}
	})
})
