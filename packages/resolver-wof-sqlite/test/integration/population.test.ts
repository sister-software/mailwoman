import { buildPlaceSearchFTS } from "@mailwoman/resolver-wof-sqlite/fts"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite/lookup"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

interface FixturePlace {
	id: number
	name: string
	country: string
	lat: number
	lon: number
	population?: number
}

const FIXTURE: FixturePlace[] = [
	{ id: 1001, name: "Springfield", country: "US", lat: 39.8, lon: -89.65, population: 112_544 },
	{ id: 1002, name: "Springfield", country: "US", lat: 42.1, lon: -72.54, population: 153_672 },
	{ id: 1003, name: "Springfield", country: "US", lat: 37.2, lon: -93.28, population: 171_589 },

	{ id: 1004, name: "Springfield", country: "US", lat: 33.5, lon: -81.28, population: undefined },

	{ id: 1100, name: "Tokyo", country: "JP", lat: 35.68, lon: 139.69, population: 13_500_000 },
]

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

		if (p.population !== undefined) {
			insertPop.run(p.id, p.population)
		}
	}

	return db
}

let lookup: WOFSQLitePlaceLookup

beforeEach(() => {
	lookup = new WOFSQLitePlaceLookup({ database: buildFixtureDB(), buildFTS: true })
})

afterEach(() => {
	lookup[Symbol.dispose]()
})

describe("buildPlaceSearchFTS — done-phase summary", () => {
	test("reports the FTS + bbox table counts (population is built upstream, not here)", () => {
		using db = buildFixtureDB()
		let doneDetail: string | undefined

		buildPlaceSearchFTS(db, {
			onProgress: (phase, detail) => {
				if (phase === "done") {
					doneDetail = detail
				}
			},
		})

		expect(doneDetail).toMatch(/FTS rows/)
		expect(doneDetail).toMatch(/bbox rows/)
	})
})

describe("findPlace — population boost", () => {
	test("returns population on candidates when present", async () => {
		const candidates = await lookup.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })
		const springfieldMA = candidates.find((c) => c.id === 1002)
		expect(springfieldMA?.population).toBe(153_672)

		const springfieldSC = candidates.find((c) => c.id === 1004)
		expect(springfieldSC?.population).toBeUndefined()
	})

	test("orders Springfields by population — MO (172k) > MA (153k) > IL (112k) > SC (no pop)", async () => {
		const candidates = await lookup.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })

		const springfields = candidates.filter((c) => c.name === "Springfield")
		expect(springfields).toHaveLength(4)
		const ids = springfields.map((c) => c.id)

		expect(ids[0]).toBe(1003)
		expect(ids[1]).toBe(1002)
		expect(ids[2]).toBe(1001)
		expect(ids[3]).toBe(1004)
	})

	test("the population boost can be tuned to 0 — falls back to BM25-only ordering", async () => {
		using dbg = new WOFSQLitePlaceLookup({ database: buildFixtureDB(), buildFTS: true }, { populationBoost: 0 })

		const candidates = await dbg.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })
		const springfields = candidates.filter((c) => c.name === "Springfield")
		expect(springfields).toHaveLength(4)

		const scores = new Set(springfields.map((c) => c.score.toFixed(6)))
		expect(scores.size).toBe(1)
	})

	test("population boost caps at populationBoost magnitude (Tokyo doesn't exceed it)", async () => {
		const candidates = await lookup.findPlace({ text: "Tokyo", placetype: "locality" })
		expect(candidates).toHaveLength(1)
		expect(candidates[0]?.population).toBe(13_500_000)
	})

	test("DB without place_population table → no boost, lookup still works", async () => {
		const db = buildFixtureDB()
		buildPlaceSearchFTS(db)
		db.exec(`DROP TABLE place_population`)
		using fallback = new WOFSQLitePlaceLookup({ database: db })

		const candidates = await fallback.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })

		const springfields = candidates.filter((c) => c.name === "Springfield")
		expect(springfields).toHaveLength(4)

		for (const c of springfields) {
			expect(c.population).toBeUndefined()
		}

		const scores = new Set(springfields.map((c) => c.score.toFixed(6)))
		expect(scores.size).toBe(1)
	})
})
