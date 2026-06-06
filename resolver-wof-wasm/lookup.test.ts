/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end tests for `WofWasmPlaceLookup` — build a small slim WOF DB from a fixture using
 *   `buildSlimWofDatabase` (Phase B.1), load it into `@sqlite.org/sqlite-wasm`, run queries, assert
 *   parity with the SQLite implementation. Runs in Node because the sqlite-wasm runtime works in
 *   Node too (it's the same .wasm built once and used everywhere).
 */

import { buildSlimWofDatabase } from "@mailwoman/resolver-wof-sqlite/build-slim"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { loadSlimWofDatabase } from "./loader.js"
import { WofWasmPlaceLookup } from "./lookup.js"

let scratch: string
let slimBytes: Uint8Array

function buildFixtureWof(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE geojson (id INTEGER PRIMARY KEY, body TEXT);

		INSERT INTO spr VALUES (100, NULL, 'United States', 'country', 'US', 39.0, -97.0, 24.5, 49.4, -125.0, -66.9, -1, 0);
		INSERT INTO spr VALUES (101, 100, 'Illinois', 'region', 'US', 40.0, -89.0, 37.0, 42.5, -91.5, -87.0, -1, 0);
		INSERT INTO spr VALUES (200, 101, 'Chicago', 'locality', 'US', 41.88, -87.63, 41.6, 42.0, -87.9, -87.5, -1, 0);
		INSERT INTO spr VALUES (201, 101, 'Springfield', 'locality', 'US', 39.80, -89.65, 39.7, 39.9, -89.8, -89.5, -1, 0);
		INSERT INTO spr VALUES (300, 201, '62701', 'postalcode', 'US', 39.81, -89.65, 39.80, 39.82, -89.66, -89.64, -1, 0);
		INSERT INTO spr VALUES (301, 200, '60601', 'postalcode', 'US', 41.88, -87.62, 41.87, 41.89, -87.63, -87.61, -1, 0);

		-- Two same-name localities: the SMALL one has the LOWER id, so on raw bm25 (identical FTS
		-- doc -> tie -> rowid order) it would surface first. The population boost must flip this so
		-- the larger Greenville wins -- the regression guard for the "New York -> West New York" bug.
		INSERT INTO spr VALUES (210, 101, 'Greenville', 'locality', 'US', 34.85, -82.39, 34.7, 35.0, -82.5, -82.2, -1, 0);
		INSERT INTO spr VALUES (211, 101, 'Greenville', 'locality', 'US', 35.61, -77.37, 35.5, 35.7, -77.5, -77.2, -1, 0);
		-- Exact-name tiering must beat population: 'York' (tiny) outranks 'New York' (huge) for "York".
		INSERT INTO spr VALUES (220, 101, 'York', 'locality', 'US', 39.96, -76.73, 39.9, 40.0, -76.8, -76.6, -1, 0);
		INSERT INTO spr VALUES (221, 101, 'New York', 'locality', 'US', 40.71, -74.0, 40.5, 40.9, -74.2, -73.7, -1, 0);

		INSERT INTO names (id, language, name) VALUES (100, 'eng', 'America');
		INSERT INTO names (id, language, name) VALUES (200, 'eng', 'Chicago');
		INSERT INTO names (id, language, name) VALUES (201, 'eng', 'Springfield');
		INSERT INTO names (id, language, name) VALUES (300, 'eng', 'Springfield ZIP');
		INSERT INTO names (id, language, name) VALUES (210, 'eng', 'Greenville');
		INSERT INTO names (id, language, name) VALUES (211, 'eng', 'Greenville');
		INSERT INTO names (id, language, name) VALUES (220, 'eng', 'York');
		INSERT INTO names (id, language, name) VALUES (221, 'eng', 'New York');

		INSERT INTO geojson VALUES (100, '{"properties":{"wof:population":331000000}}');
		INSERT INTO geojson VALUES (101, '{"properties":{"wof:population":12700000}}');
		INSERT INTO geojson VALUES (200, '{"properties":{"wof:population":2700000}}');
		INSERT INTO geojson VALUES (201, '{"properties":{"wof:population":114000}}');
		INSERT INTO geojson VALUES (300, '{"properties":{}}');
		INSERT INTO geojson VALUES (301, '{"properties":{}}');
		INSERT INTO geojson VALUES (210, '{"properties":{"wof:population":8000}}');
		INSERT INTO geojson VALUES (211, '{"properties":{"wof:population":580000}}');
		INSERT INTO geojson VALUES (220, '{"properties":{"wof:population":1700}}');
		INSERT INTO geojson VALUES (221, '{"properties":{"wof:population":8400000}}');
	`)
	db.close()
}

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-wasm-"))
	const source = join(scratch, "src.db")
	const output = join(scratch, "slim.db")
	buildFixtureWof(source)
	await buildSlimWofDatabase({ inputs: [source], output, topLocalitiesPerCountry: 10 })
	slimBytes = await readFile(output)
})

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("WofWasmPlaceLookup", () => {
	test("opens a slim DB and resolves a locality", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })
		try {
			const matches = await lookup.findPlace({ text: "Chicago", placetype: "locality", limit: 3 })
			expect(matches.length).toBeGreaterThan(0)
			expect(matches[0]?.name).toBe("Chicago")
			expect(matches[0]?.placetype).toBe("locality")
			expect(matches[0]?.country).toBe("US")
			expect(matches[0]?.lat).toBeCloseTo(41.88, 1)
		} finally {
			lookup.close()
		}
	})

	test("resolves a postcode via the postalcode placetype filter", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })
		try {
			const matches = await lookup.findPlace({ text: "62701", placetype: "postalcode" })
			expect(matches.length).toBe(1)
			expect(matches[0]?.name).toBe("62701")
		} finally {
			lookup.close()
		}
	})

	test("population surfaces the larger of two same-name localities", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })
		try {
			const matches = await lookup.findPlace({ text: "Greenville", placetype: "locality", country: "US", limit: 5 })
			// Both are exact-name matches (same tier), so the population boost is the tiebreak. The
			// larger Greenville (id 211) must beat the lower-id small one (210) that raw bm25 favors.
			expect(matches[0]?.id).toBe(211)
		} finally {
			lookup.close()
		}
	})

	test("exact-name match outranks a larger partial-name place", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })
		try {
			// "York" matches both 'York' and 'New York'; exact-name tiering must keep 'York' on top
			// even though 'New York' has a far larger population (the ME->Maine-not-Missouri guard).
			const matches = await lookup.findPlace({ text: "York", placetype: "locality", country: "US", limit: 5 })
			expect(matches[0]?.name).toBe("York")
		} finally {
			lookup.close()
		}
	})

	test("bbox filter constrains same-name localities to a region's bounds", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })
		try {
			// Both Greenvilles match by name, but only id 210 (34.85,-82.39) sits in this box — the
			// 'Roseville, Michigan' disambiguation path (constrain a locality to a parsed region's bbox).
			const matches = await lookup.findPlace({
				text: "Greenville",
				placetype: "locality",
				bbox: { minLat: 34, maxLat: 35, minLon: -83, maxLon: -82 },
				limit: 5,
			})
			expect(matches.map((m) => m.id)).toEqual([210])
		} finally {
			lookup.close()
		}
	})

	test("country filter rejects out-of-scope matches", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })
		try {
			const matches = await lookup.findPlace({ text: "Springfield", country: "FR" })
			expect(matches).toEqual([])
		} finally {
			lookup.close()
		}
	})

	test("returns [] for empty / whitespace-only text", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })
		try {
			expect(await lookup.findPlace({ text: "" })).toEqual([])
			expect(await lookup.findPlace({ text: "   " })).toEqual([])
		} finally {
			lookup.close()
		}
	})
})
