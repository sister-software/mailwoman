/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proximity + bbox tests for `WOFSqlitePlaceLookup` — exercises the R*Tree integration via the
 *   fixture-DB pattern. Real-WOF coverage lives in `integration.test.ts`.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { bboxAround, haversineKm } from "./geo.js"
import { WOFSqlitePlaceLookup } from "./lookup.js"

interface FixturePlace {
	id: number
	name: string
	placetype: string
	country: string
	lat: number
	lon: number
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number }
}

const FIXTURE: FixturePlace[] = [
	// Paris, FR
	{
		id: 101751119,
		name: "Paris",
		placetype: "locality",
		country: "FR",
		lat: 48.85,
		lon: 2.34,
		bbox: { minLat: 48.81, maxLat: 48.9, minLon: 2.22, maxLon: 2.46 },
	},
	// Paris, TX (small US town)
	{
		id: 101715829,
		name: "Paris",
		placetype: "locality",
		country: "US",
		lat: 33.66,
		lon: -95.55,
		bbox: { minLat: 33.62, maxLat: 33.7, minLon: -95.6, maxLon: -95.5 },
	},
	// Tokyo, JP
	{
		id: 1108794869,
		name: "Tokyo",
		placetype: "locality",
		country: "JP",
		lat: 35.68,
		lon: 139.69,
		bbox: { minLat: 35.5, maxLat: 35.83, minLon: 139.34, maxLon: 139.91 },
	},
	// London, GB
	{
		id: 101750367,
		name: "London",
		placetype: "locality",
		country: "GB",
		lat: 51.51,
		lon: -0.13,
		bbox: { minLat: 51.28, maxLat: 51.69, minLon: -0.51, maxLon: 0.33 },
	},
]

function buildFixtureDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY,
			parent_id INTEGER,
			name TEXT,
			placetype TEXT,
			country TEXT,
			latitude REAL,
			longitude REAL,
			min_latitude REAL, max_latitude REAL,
			min_longitude REAL, max_longitude REAL,
			is_current INTEGER,
			is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
	`)
	const insertSpr = db.prepare(`
		INSERT INTO spr (id, parent_id, name, placetype, country,
		                 latitude, longitude,
		                 min_latitude, max_latitude, min_longitude, max_longitude,
		                 is_current, is_deprecated)
		VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, -1, 0)
	`)

	for (const p of FIXTURE) {
		insertSpr.run(
			p.id,
			p.name,
			p.placetype,
			p.country,
			p.lat,
			p.lon,
			p.bbox.minLat,
			p.bbox.maxLat,
			p.bbox.minLon,
			p.bbox.maxLon
		)
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

describe("haversineKm (sanity)", () => {
	test("Paris,FR → London,GB is ~344 km", () => {
		const d = haversineKm(48.85, 2.34, 51.51, -0.13)
		expect(d).toBeGreaterThan(330)
		expect(d).toBeLessThan(360)
	})
	test("Paris,FR → Paris,TX is ~7800 km", () => {
		const d = haversineKm(48.85, 2.34, 33.66, -95.55)
		expect(d).toBeGreaterThan(7700)
		expect(d).toBeLessThan(7900)
	})
	test("identity is exactly 0", () => {
		expect(haversineKm(48.85, 2.34, 48.85, 2.34)).toBe(0)
	})
})

describe("bboxAround (sanity)", () => {
	test("100 km radius around Paris,FR is roughly ±0.9° lat, ±1.4° lon", () => {
		const b = bboxAround(48.85, 2.34, 100)
		expect(b.maxLat - b.minLat).toBeGreaterThan(1.7)
		expect(b.maxLat - b.minLat).toBeLessThan(1.9)
		// At 48.85° latitude, cos ≈ 0.658 → lonDelta ≈ 1.37° each side → ~2.74° total
		expect(b.maxLon - b.minLon).toBeGreaterThan(2.6)
		expect(b.maxLon - b.minLon).toBeLessThan(2.9)
	})
	test("doesn't divide-by-zero at the pole", () => {
		expect(() => bboxAround(90, 0, 100)).not.toThrow()
		expect(() => bboxAround(-90, 0, 100)).not.toThrow()
	})
})

describe("findPlace — proximity boost", () => {
	test("near: {Paris,FR coords} ranks Paris,FR ahead of Paris,TX", async () => {
		const candidates = await lookup.findPlace({
			text: "Paris",
			placetype: "locality",
			near: { lat: 48.85, lon: 2.34 },
		})
		expect(candidates.length).toBeGreaterThanOrEqual(2)
		expect(candidates[0]?.country).toBe("FR")
		// Both candidates should carry distanceKm.
		expect(candidates[0]?.distanceKm).toBeCloseTo(0, 0)
		expect(candidates.find((c) => c.country === "US")?.distanceKm).toBeGreaterThan(7000)
	})

	test("near: {Texas coords} ranks Paris,TX ahead of Paris,FR", async () => {
		// Coordinates of Dallas, TX
		const candidates = await lookup.findPlace({
			text: "Paris",
			placetype: "locality",
			near: { lat: 32.78, lon: -96.8 },
		})
		expect(candidates[0]?.country).toBe("US")
	})

	test("near.maxDistanceKm filters out far candidates entirely", async () => {
		const candidates = await lookup.findPlace({
			text: "Paris",
			placetype: "locality",
			near: { lat: 48.85, lon: 2.34, maxDistanceKm: 100 },
		})
		// Only Paris,FR is within 100 km of Paris,FR.
		expect(candidates.map((c) => c.country)).toEqual(["FR"])
	})
})

describe("findPlace — bbox filter", () => {
	test("bbox that intersects France returns Paris,FR only (among Parises)", async () => {
		const candidates = await lookup.findPlace({
			text: "Paris",
			placetype: "locality",
			bbox: { minLat: 48, maxLat: 49, minLon: 2, maxLon: 3 },
		})
		expect(candidates.map((c) => c.country)).toEqual(["FR"])
	})

	test("bbox that intersects neither Paris returns []", async () => {
		const candidates = await lookup.findPlace({
			text: "Paris",
			placetype: "locality",
			bbox: { minLat: -10, maxLat: -9, minLon: -10, maxLon: -9 }, // South Atlantic — nothing here
		})
		expect(candidates).toEqual([])
	})

	test("bbox spanning both Parises returns both", async () => {
		const candidates = await lookup.findPlace({
			text: "Paris",
			placetype: "locality",
			bbox: { minLat: 30, maxLat: 50, minLon: -100, maxLon: 5 },
		})
		expect(candidates.length).toBe(2)
	})
})

describe("findPlace — backwards compat", () => {
	test("queries without near/bbox still work (no R*Tree JOIN)", async () => {
		const candidates = await lookup.findPlace({ text: "London", placetype: "locality" })
		expect(candidates.length).toBe(1)
		expect(candidates[0]?.country).toBe("GB")
		expect(candidates[0]?.distanceKm).toBeUndefined()
	})

	test("near + bbox without R*Tree (legacy DB) is silently ignored; no crash, no proximity filter", async () => {
		// Simulate an older DB that has FTS5 but NOT the R*Tree bbox index (built before this PR).
		const db = buildFixtureDb()
		db.exec(`
			CREATE VIRTUAL TABLE place_search USING fts5(
				wof_id UNINDEXED, name, alt_names,
				tokenize = 'unicode61 remove_diacritics 2'
			);
			INSERT INTO place_search (wof_id, name, alt_names) SELECT id, name, '' FROM spr;
		`)
		const oldLookup = new WOFSqlitePlaceLookup({ database: db })

		try {
			// bbox option should be silently ignored — without the R*Tree we can't filter at SQL level,
			// and dropping the option to ensure no-crash is the chosen contract (documented in types.ts).
			const all = await oldLookup.findPlace({
				text: "Paris",
				placetype: "locality",
				bbox: { minLat: -10, maxLat: -9, minLon: -10, maxLon: -9 },
			})
			// Without the bbox filter (silently dropped) all Parises are returned.
			expect(all.length).toBe(2)

			// `near` without `maxDistanceKm` is purely a boost — works without the R*Tree because the
			// haversine math runs on each row's centroid columns.
			const near = await oldLookup.findPlace({
				text: "Paris",
				placetype: "locality",
				near: { lat: 48.85, lon: 2.34 },
			})
			expect(near[0]?.country).toBe("FR")
			expect(near[0]?.distanceKm).toBeCloseTo(0, 0)
		} finally {
			oldLookup.close()
		}
	})
})
