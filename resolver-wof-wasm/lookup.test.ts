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

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { buildSlimWofDatabase } from "@mailwoman/resolver-wof-sqlite/build-slim"
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
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);

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

		-- The Brooklyn pair (live-demo bug, 2026-06-11): WOF files Brooklyn-the-borough as placetype
		-- 'borough', NOT 'locality'. A locality query must reach it via the shared placetype expansion
		-- (core/resolver PLACETYPE_FILTER_GROUPS) — otherwise the only locality-typed match is the
		-- fuzzy 'Brooklyn Park' and the resolver mislocates to Minnesota.
		INSERT INTO spr VALUES (230, 101, 'Brooklyn', 'borough', 'US', 40.64, -73.95, 40.57, 40.74, -74.04, -73.83, -1, 0);
		INSERT INTO spr VALUES (231, 101, 'Brooklyn Park', 'locality', 'US', 45.11, -93.35, 45.07, 45.15, -93.40, -93.30, -1, 0);

		INSERT INTO names (id, language, name) VALUES (100, 'eng', 'America');
		INSERT INTO names (id, language, name) VALUES (200, 'eng', 'Chicago');
		INSERT INTO names (id, language, name) VALUES (201, 'eng', 'Springfield');
		INSERT INTO names (id, language, name) VALUES (300, 'eng', 'Springfield ZIP');
		INSERT INTO names (id, language, name) VALUES (210, 'eng', 'Greenville');
		INSERT INTO names (id, language, name) VALUES (211, 'eng', 'Greenville');
		INSERT INTO names (id, language, name) VALUES (220, 'eng', 'York');
		INSERT INTO names (id, language, name) VALUES (221, 'eng', 'New York');
		-- WOF carries 'New York City' as an ALIAS of the New York locality — the FTS alt_names bag is
		-- the slim DB's only surviving alias source, and the alias-exact tier must consult it.
		INSERT INTO names (id, language, name) VALUES (221, 'eng', 'New York City');
		INSERT INTO names (id, language, name) VALUES (230, 'eng', 'Brooklyn');
		INSERT INTO names (id, language, name) VALUES (231, 'eng', 'Brooklyn Park');
		-- Alias-bag boundary fixture (#523): two aliases whose concatenation straddles the phrase
		-- "York New". The boundary-preserving separator must keep the exact tier from promoting this
		-- place (or 'New York', whose alias bag also straddles it) for the straddling query.
		INSERT INTO spr VALUES (240, 101, 'Twin Hamlet', 'locality', 'US', 40.2, -76.8, 40.1, 40.3, -76.9, -76.7, -1, 0);
		INSERT INTO names (id, language, name) VALUES (240, 'eng', 'Old York');
		INSERT INTO names (id, language, name) VALUES (240, 'eng', 'New City');

		-- Pre-built population aux table (production shape — build-unified-wof extracts wof:population
		-- here at ingest; the source has no geojson table). Postcodes (300/301) carry no population row.
		INSERT INTO place_population VALUES (100, 331000000);
		INSERT INTO place_population VALUES (101, 12700000);
		INSERT INTO place_population VALUES (200, 2700000);
		INSERT INTO place_population VALUES (201, 114000);
		INSERT INTO place_population VALUES (210, 8000);
		INSERT INTO place_population VALUES (211, 580000);
		INSERT INTO place_population VALUES (220, 1700);
		INSERT INTO place_population VALUES (221, 8400000);
		INSERT INTO place_population VALUES (230, 2504700);
		INSERT INTO place_population VALUES (231, 82000);
		INSERT INTO place_population VALUES (240, 50);

		-- Region abbreviation tiering (#189): 'Vermontstate' (tiny pop) carries the exact abbrev 'VT';
		-- 'Vt Plains' (huge pop) only TOKEN-matches "vt". build-slim materializes place_abbr (110→VT) so
		-- the WASM resolver tiers the exact-abbrev holder above the populous token match.
		INSERT INTO spr VALUES (110, 100, 'Vermontstate', 'region', 'US', 44.0, -72.7, 42.7, 45.0, -73.4, -71.5, -1, 0);
		INSERT INTO spr VALUES (111, 100, 'Vt Plains', 'region', 'US', 38.0, -99.0, 36.0, 40.0, -101.0, -97.0, -1, 0);
		INSERT INTO names (id, language, name) VALUES (110, 'eng', 'Vermontstate');
		INSERT INTO names (id, language, name) VALUES (110, 'abbr', 'VT');
		INSERT INTO names (id, language, name) VALUES (111, 'eng', 'Vt Plains');
		INSERT INTO place_population VALUES (110, 1000);
		INSERT INTO place_population VALUES (111, 100000000);

		-- Dual-role relation (#402): Illinois(101) ⊃ Springfield(201). build-slim carries it to the slim DB.
		CREATE TABLE coincident_roles (
			admin_id INTEGER NOT NULL, locality_id INTEGER NOT NULL, relationship_type TEXT NOT NULL,
			admin_placetype TEXT NOT NULL, distance_km REAL NOT NULL, locality_population INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (admin_id, locality_id));
		INSERT INTO coincident_roles VALUES (101, 201, 'capital-seat', 'region', 5.0, 114000);
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
	test("coincidentLocalitiesFor reads the relation carried into the slim DB (#402)", async () => {
		// End-to-end: the fixture source had coincident_roles → build-slim carried it → the WASM lookup reads it.
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })

		try {
			const roles = lookup.coincidentLocalitiesFor(101) // Illinois
			expect(roles).toHaveLength(1)
			expect(roles[0]).toMatchObject({
				id: 201,
				name: "Springfield",
				placetype: "locality",
				relationshipType: "capital-seat",
			})
			expect(lookup.coincidentLocalitiesFor(99999)).toHaveLength(0)
		} finally {
			lookup.close()
		}
	})

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

	test("exact-abbreviation tiering via place_abbr beats a populous token match (#189)", async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })

		try {
			const matches = await lookup.findPlace({ text: "VT", placetype: "region", limit: 5 })
			// 'Vermontstate' holds the exact abbrev "VT" (place_abbr 110→VT, tiny pop); 'Vt Plains' only
			// token-matches "vt" with a huge population. The exact-abbrev tier must win — the data-driven
			// replacement for the demo's hardcoded expandUsRegion map.
			expect(matches[0]?.id).toBe(110)
			expect(matches[0]?.name).toBe("Vermontstate")
			expect(matches[0]?.exactMatch).toBe(true)
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

	test('"Brooklyn" locality query reaches the exact-named borough over the fuzzy "Brooklyn Park" (placetype expansion)', async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })

		try {
			// Live-demo bug (2026-06-11): a strict placetype='locality' filter excluded the borough, so
			// "Brooklyn" resolved to Brooklyn Park, MN. The shared expansion (locality → locality +
			// borough + localadmin) makes the exact-named borough reachable; exact tiering puts it first.
			const matches = await lookup.findPlace({ text: "Brooklyn", placetype: "locality", limit: 5 })
			expect(matches[0]).toMatchObject({ id: 230, name: "Brooklyn", placetype: "borough" })
			expect(matches[0]?.exactMatch).toBe(true)
		} finally {
			lookup.close()
		}
	})

	test('"Brooklyn" + a New-York-ish bbox returns the borough (the region-constrained cascade path)', async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })

		try {
			// Mirrors "brooklyn, new york, ny": the parsed region's bbox constrains the locality lookup.
			// Pre-expansion this returned NOTHING (the borough was filtered out, Brooklyn Park is outside
			// the bbox), and the cascade silently fell back to the unconstrained — wrong — hit.
			const matches = await lookup.findPlace({
				text: "Brooklyn",
				placetype: "locality",
				bbox: { minLat: 40.4, maxLat: 45.1, minLon: -79.8, maxLon: -71.7 },
				limit: 5,
			})
			expect(matches.map((m) => m.id)).toEqual([230])
		} finally {
			lookup.close()
		}
	})

	test('alias-exact tier: "New York City" resolves the New York locality via its WOF alias', async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })

		try {
			const matches = await lookup.findPlace({ text: "New York City", placetype: "locality", limit: 5 })
			expect(matches[0]).toMatchObject({ id: 221, name: "New York" })
			// The alias lives only in the FTS alt_names bag on a slim DB — the tier must consult it.
			expect(matches[0]?.exactMatch).toBe(true)
		} finally {
			lookup.close()
		}
	})

	test('alias-bag boundary: "York New" straddling two aliases never claims the exact tier (#523)', async () => {
		const { db } = await loadSlimWofDatabase({ source: slimBytes })
		const lookup = new WofWasmPlaceLookup({ db })

		try {
			// "York New" token-matches both Twin Hamlet (bag "Old York <sep> New City") and New York
			// (name + alias "New York City"). Pre-#523, the space-joined bags let the padded containment
			// check false-promote BOTH (' old york new city ' and ' new york new york city ' each
			// contain ' york new '). With the separator, no candidate may claim the exact tier.
			const straddle = await lookup.findPlace({ text: "York New", placetype: "locality", limit: 5 })
			expect(straddle.length).toBeGreaterThan(0) // still token-reachable…
			expect(straddle.some((m) => m.exactMatch === true)).toBe(false) // …but never exact
			// A single alias still earns the exact tier from the bag alone.
			const alias = await lookup.findPlace({ text: "New City", placetype: "locality", limit: 5 })
			expect(alias[0]).toMatchObject({ id: 240, name: "Twin Hamlet" })
			expect(alias[0]?.exactMatch).toBe(true)
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
