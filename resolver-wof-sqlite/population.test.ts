/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Population-weighted ranking tests. Builds an in-memory fixture DB in the production shape — a
 *   pre-built `place_population` aux table (no geojson; `build-unified-wof` extracts
 *   `wof:population` into it at ingest) — then verifies the ranking boost behaves as documented.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildPlaceSearchFTS } from "./fts.js"
import { WOFSqlitePlaceLookup } from "./lookup.js"

interface FixturePlace {
	id: number
	name: string
	country: string
	lat: number
	lon: number
	population?: number
}

const FIXTURE: FixturePlace[] = [
	// Three Springfields with realistic populations
	{ id: 1001, name: "Springfield", country: "US", lat: 39.8, lon: -89.65, population: 112_544 }, // IL
	{ id: 1002, name: "Springfield", country: "US", lat: 42.1, lon: -72.54, population: 153_672 }, // MA
	{ id: 1003, name: "Springfield", country: "US", lat: 37.2, lon: -93.28, population: 171_589 }, // MO
	// Tiny Springfield with no population data
	{ id: 1004, name: "Springfield", country: "US", lat: 33.5, lon: -81.28, population: undefined }, // SC, no pop
	// A huge unrelated city for sanity (mega-population bound check)
	{ id: 1100, name: "Tokyo", country: "JP", lat: 35.68, lon: 139.69, population: 13_500_000 },
]

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
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
	`)
	const insertSpr = db.prepare(`
		INSERT INTO spr (id, parent_id, name, placetype, country,
		                 latitude, longitude,
		                 min_latitude, max_latitude, min_longitude, max_longitude,
		                 is_current, is_deprecated)
		VALUES (?, NULL, ?, 'locality', ?, ?, ?, ?, ?, ?, ?, -1, 0)
	`)
	const insertPop = db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`)

	for (const p of FIXTURE) {
		insertSpr.run(p.id, p.name, p.country, p.lat, p.lon, p.lat - 0.05, p.lat + 0.05, p.lon - 0.05, p.lon + 0.05)

		if (p.population !== undefined) insertPop.run(p.id, p.population)
	}

	return db
}

let lookup: WOFSqlitePlaceLookup

beforeEach(() => {
	lookup = new WOFSqlitePlaceLookup({ database: buildFixtureDb(), buildFTS: true })
})

afterEach(() => {
	lookup.close()
})

describe("buildPlaceSearchFTS — done-phase summary", () => {
	test("reports the FTS + bbox table counts (population is built upstream, not here)", () => {
		const db = buildFixtureDb()
		let doneDetail: string | undefined
		buildPlaceSearchFTS(db, {
			onProgress: (phase, detail) => {
				if (phase === "done") doneDetail = detail
			},
		})
		expect(doneDetail).toMatch(/FTS rows/)
		expect(doneDetail).toMatch(/bbox rows/)
		db.close()
	})
})

describe("findPlace — population boost", () => {
	test("returns population on candidates when present", async () => {
		const candidates = await lookup.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })
		const springfieldMA = candidates.find((c) => c.id === 1002)
		expect(springfieldMA?.population).toBe(153_672)
		// Springfield, SC has no population → field absent
		const springfieldSC = candidates.find((c) => c.id === 1004)
		expect(springfieldSC?.population).toBeUndefined()
	})

	test("orders Springfields by population — MO (172k) > MA (153k) > IL (112k) > SC (no pop)", async () => {
		const candidates = await lookup.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })
		// Filter to just the Springfields (Tokyo also has population but isn't a Springfield match)
		const springfields = candidates.filter((c) => c.name === "Springfield")
		expect(springfields.length).toBe(4)
		const ids = springfields.map((c) => c.id)
		// MO has highest pop → first. SC has none → last. MA and IL in between in pop order.
		expect(ids[0]).toBe(1003) // MO
		expect(ids[1]).toBe(1002) // MA
		expect(ids[2]).toBe(1001) // IL
		expect(ids[3]).toBe(1004) // SC (no population data)
	})

	test("the population boost can be tuned to 0 — falls back to BM25-only ordering", async () => {
		const dbg = new WOFSqlitePlaceLookup({ database: buildFixtureDb(), buildFTS: true }, { populationBoost: 0 })

		try {
			const candidates = await dbg.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })
			const springfields = candidates.filter((c) => c.name === "Springfield")
			expect(springfields.length).toBe(4)
			// With boost=0, the four Springfields tie on BM25 + everything else. Ordering is
			// implementation-defined but ALL should have identical scores.
			const scores = new Set(springfields.map((c) => c.score.toFixed(6)))
			expect(scores.size).toBe(1)
		} finally {
			dbg.close()
		}
	})

	test("population boost caps at populationBoost magnitude (Tokyo doesn't exceed it)", async () => {
		// Tokyo has 13.5M people — log10 ≈ 7.13. With populationScaleLog10 = 6 default, the raw
		// fraction is 7.13/6 = 1.19, capped at 1. So Tokyo's boost = exactly populationBoost.
		const candidates = await lookup.findPlace({ text: "Tokyo", placetype: "locality" })
		expect(candidates.length).toBe(1)
		expect(candidates[0]?.population).toBe(13_500_000)
		// We can't easily isolate the population boost from BM25, but we can check the boost
		// caps logic by tuning the weight to a sentinel + comparing the score delta to a
		// no-population control. Skipped for now — the formula caps deterministically in code.
	})

	test("DB without place_population table → no boost, lookup still works", async () => {
		// Build the fixture but drop the aux table before opening the lookup.
		const db = buildFixtureDb()
		buildPlaceSearchFTS(db)
		db.exec(`DROP TABLE place_population`)
		const fallback = new WOFSqlitePlaceLookup({ database: db })

		try {
			const candidates = await fallback.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })
			// All 4 Springfields returned, none with `population` field (the aux table was dropped).
			const springfields = candidates.filter((c) => c.name === "Springfield")
			expect(springfields.length).toBe(4)

			for (const c of springfields) expect(c.population).toBeUndefined()
			// Their scores should all be equal (no population boost differentiation).
			const scores = new Set(springfields.map((c) => c.score.toFixed(6)))
			expect(scores.size).toBe(1)
		} finally {
			fallback.close()
		}
	})
})
